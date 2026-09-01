import { Context, Service, Schema } from 'cordis'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FuzzyPatchEngine, PatchMatchResult, ReplacementChunk } from './fuzzy.js'

export interface SmartPatchConfig {
  /** Create automatic .bak backup files before modifying. Default: false */
  createBackup?: boolean
  /** Restrict file modifications strictly within this workspace root directory */
  workspaceRoot?: string
}

export const SmartPatchConfig: Schema<SmartPatchConfig> = Schema.object({
  createBackup: Schema.boolean().default(false).description('Create .bak backup files before applying patches.'),
  workspaceRoot: Schema.string().default('').description('Restrict file modifications within workspace root.'),
})

declare module 'cordis' {
  interface Context {
    smartPatch: SmartPatchService
    fs?: any
    logger?: any
  }
}

/**
 * DeepSeek Harness Micro-surgical Code Patching Service.
 *
 * Safety model (C4/C7/M14):
 * - containment is checked on *realpaths*: symlinks/junctions are resolved and
 *   the resolved target must stay inside the resolved workspace root;
 * - read-modify-write cycles are serialized per file via an async queue;
 * - writes go to a unique temp file that inherits the original mode, then
 *   rename; an mtime+size CAS rejects overwriting externally modified files;
 * - backups are refused when the `.bak` path is already a symlink.
 */
export class SmartPatchService extends Service<SmartPatchConfig> {
  /** Cordis validates plugin config against this schema. */
  public static Config = SmartPatchConfig

  /** Per-realpath serialization queues (M14: no lost updates between our calls). */
  private fileQueues = new Map<string, Promise<unknown>>()

  constructor(ctx: Context, config: SmartPatchConfig = {}) {
    super(ctx, 'smartPatch', true)
    this.config = SmartPatchConfig(config) as SmartPatchConfig
  }

  /**
   * Run `task` exclusively for `key`, serializing concurrent callers.
   */
  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.fileQueues.get(key) ?? Promise.resolve()
    const run = prev.then(task, task)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.fileQueues.set(key, tail)
    tail.then(() => {
      if (this.fileQueues.get(key) === tail) this.fileQueues.delete(key)
    })
    return run
  }

  /**
   * Resolve `filePath` against the workspace root, following symlinks/junctions,
   * and verify the resolved target stays inside the resolved root.
   * Returns the canonical (realpath) target.
   */
  private async resolveInsideWorkspace(filePath: string): Promise<string> {
    const rootRaw = this.config.workspaceRoot || process.cwd()
    const rootAbs = path.resolve(rootRaw)
    const targetAbs = path.resolve(rootAbs, filePath)

    // 1. Cheap segment-aware boundary check on the raw absolute paths (blocks
    //    D:\work2 when root is D:\work before any fs work).
    const insideSegments = (abs: string, root: string): boolean =>
      abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep)
    if (!insideSegments(targetAbs, rootAbs)) {
      throw new Error(`Access denied: Target path '${filePath}' is outside workspace root '${rootRaw}'.`)
    }

    // 2. Canonicalize: resolve junctions/symlinks/reparse points for the root
    //    and the target itself (C4). realpath(targetAbs) follows file-level
    //    symlinks; if the file does not exist yet, resolve its parent dir.
    const realRoot = await fs.realpath(rootAbs).catch(() => null)
    if (!realRoot) {
      throw new Error(`Workspace root does not exist: '${rootRaw}'.`)
    }
    const realTarget = await fs
      .realpath(targetAbs)
      .catch(async () => {
        const realDir = await fs.realpath(path.dirname(targetAbs)).catch(() => null)
        if (!realDir) {
          throw new Error(`Target directory does not exist: '${path.dirname(filePath)}'.`)
        }
        return path.join(realDir, path.basename(targetAbs))
      })

    // 3. Re-check containment on canonical paths. Case-insensitive only on
    //    Windows; POSIX keeps case-sensitive semantics (C4).
    const fold = (s: string): string => (process.platform === 'win32' ? s.toLowerCase() : s)
    const cmpTarget = fold(realTarget)
    const cmpRoot = fold(realRoot)
    if (!(cmpTarget === cmpRoot || cmpTarget.startsWith(cmpRoot.endsWith(path.sep) ? cmpRoot : cmpRoot + path.sep))) {
      throw new Error(
        `Access denied: '${filePath}' resolves outside workspace root '${rootRaw}' (symlink/junction escape).`,
      )
    }
    return realTarget
  }

  /**
   * Serialized read-patch-write for one file.
   */
  private async patchFile(
    filePath: string,
    mutate: (fileText: string) => Promise<{ success: boolean; message: string; newContent?: string; matchType?: string; appliedChunks?: number }>,
  ): Promise<{ success: boolean; message: string; matchType?: string; appliedChunks?: number }> {
    const lockKey = path.resolve(this.config.workspaceRoot || process.cwd(), filePath)
    return this.enqueue(lockKey, async () => {
      let realPath: string
      try {
        realPath = await this.resolveInsideWorkspace(filePath)
      } catch (err: any) {
        return { success: false, message: err.message }
      }

      // Snapshot before reading so the CAS can detect external writers (C7/M14).
      const statBefore = await fs.stat(realPath).catch((err) => {
        return null
      })
      if (!statBefore) {
        return { success: false, message: `Failed to stat file '${filePath}': file may not exist.` }
      }

      let fileText: string
      try {
        fileText = await fs.readFile(realPath, 'utf-8')
      } catch (err) {
        return { success: false, message: `Failed to read file '${filePath}': ${err}` }
      }

      const patched = await mutate(fileText)
      if (!patched.success || patched.newContent === undefined) {
        return { success: patched.success, message: patched.message, matchType: patched.matchType, appliedChunks: patched.appliedChunks ?? 0 }
      }

      // Backup with symlink protection: a pre-existing .bak symlink must never
      // redirect our backup bytes outside the workspace (C7).
      if (this.config.createBackup) {
        const bakPath = `${realPath}.bak`
        const bakLstat = await fs.lstat(bakPath).catch(() => null)
        if (bakLstat?.isSymbolicLink()) {
          return { success: false, message: `Backup refused: '${filePath}.bak' is a symlink.`, appliedChunks: 0 }
        }
        try {
          await fs.writeFile(bakPath, fileText, 'utf-8')
        } catch (err) {
          return { success: false, message: `Backup creation failed for '${filePath}': ${err}`, appliedChunks: 0 }
        }
      }

      // Unique temp name: pid + timestamp + random suffix (C7 collision-proof).
      const tmpPath = `${realPath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`
      try {
        await fs.writeFile(tmpPath, patched.newContent, 'utf-8')
        // Preserve the original file's mode (executable bit / permissions, C7).
        try {
          await fs.chmod(tmpPath, statBefore.mode)
        } catch {
          /* best-effort (Windows has limited chmod semantics) */
        }
        // CAS: abort if the file changed on disk while we were patching.
        const statAfter = await fs.stat(realPath).catch(() => null)
        if (statAfter && (statAfter.mtimeMs !== statBefore.mtimeMs || statAfter.size !== statBefore.size)) {
          await fs.unlink(tmpPath).catch(() => {})
          return {
            success: false,
            message: `File '${filePath}' changed on disk during patch; aborted to avoid lost update.`,
            appliedChunks: 0,
          }
        }
        await fs.rename(tmpPath, realPath)
      } catch (err) {
        await fs.unlink(tmpPath).catch(() => {})
        return { success: false, message: `Failed to commit patch to '${filePath}': ${err}`, appliedChunks: 0 }
      }

      return {
        success: true,
        message: patched.message,
        matchType: patched.matchType,
        appliedChunks: patched.appliedChunks,
      }
    })
  }

  /**
   * Apply single replacement chunk to target file path with workspace safety checks.
   */
  public replaceInFile(
    filePath: string,
    targetContent: string,
    replacementContent: string
  ): Promise<{ success: boolean; message: string; matchType?: string }> {
    return this.patchFile(filePath, async (fileText) => {
      const result = FuzzyPatchEngine.applyReplacement(fileText, targetContent, replacementContent)
      if (!result.success) {
        return { success: false, message: result.error || 'Patch failed to match target block.' }
      }
      return {
        success: true,
        message: `Successfully applied micro-surgical patch to '${filePath}' (Match strategy: ${result.matchType}).`,
        newContent: result.newContent,
        matchType: result.matchType,
      }
    })
  }

  /**
   * Apply multiple non-contiguous replacement chunks in transactional order.
   */
  public multiReplaceInFile(
    filePath: string,
    chunks: ReplacementChunk[]
  ): Promise<{ success: boolean; message: string; appliedChunks: number }> {
    return this.patchFile(filePath, async (fileText) => {
      const result = FuzzyPatchEngine.applyMultiReplacement(fileText, chunks)
      if (!result.success) {
        return { success: false, message: result.error || 'Multi-patch failed.', appliedChunks: result.appliedChunks }
      }
      return {
        success: true,
        message: `Successfully applied ${result.appliedChunks} micro-surgical patch chunks to '${filePath}'.`,
        newContent: result.newContent,
        appliedChunks: result.appliedChunks,
      }
    }).then((r) => ({
      success: r.success,
      message: r.message,
      appliedChunks: r.appliedChunks ?? 0,
    }))
  }
}

export { FuzzyPatchEngine, PatchMatchResult, ReplacementChunk }

export default function apply(ctx: Context, config: SmartPatchConfig = {}) {
  // Validate + apply defaults at the entry point (M7 pattern).
  ctx.plugin(SmartPatchService, SmartPatchConfig(config))

  // Intercept ctx.fs.editText when fs service is loaded to transparently recover from exact-match failures
  ctx.inject(['fs'], (ctx) => {
    const fsService = ctx.fs as any
    if (!fsService || typeof fsService.editText !== 'function') return

    // Guard against double wrapping on reload
    if (fsService.__smartPatchHooked) return
    fsService.__smartPatchHooked = true

    const originalEditText = fsService.editText.bind(fsService)

    fsService.editText = async function (
      target: any,
      edit: { oldString: string; newString: string; replaceAll?: boolean },
      expected: any,
      signal: any,
      sandboxPolicy: any
    ) {
      try {
        // Tier 1: Try standard exact edit
        return await originalEditText(target, edit, expected, signal, sandboxPolicy)
      } catch (err: any) {
        // If standard edit fails because old_string was not found, trigger smart fuzzy recovery
        const isNotFound =
          err?.code === 'FS_EDIT_NOT_FOUND' ||
          (typeof err?.message === 'string' && err.message.includes('old_string was not found'))

        if (!isNotFound || !edit.oldString) {
          throw err
        }

        // Read raw file content
        let rawContent: string
        try {
          rawContent = await fsService.readText(target, signal)
        } catch {
          throw err
        }

        // Tier 2-4: Fuzzy match and apply replacement
        const patchResult = FuzzyPatchEngine.applyReplacement(rawContent, edit.oldString, edit.newString)
        if (!patchResult.success) {
          // If fuzzy recovery also fails, bubble up the original error
          throw err
        }

        // Apply write atomically with version guard
        const writeExpected =
          expected?.kind === 'replaceIfVersion'
            ? { kind: 'replaceIfVersion', version: expected.version }
            : undefined

        const writeResult = await fsService.writeText(
          target,
          patchResult.newContent,
          writeExpected,
          signal,
          sandboxPolicy
        )

        ctx.logger?.info?.(
          `[dsh-plugin-smart-patch] Successfully recovered edit on "${target.displayPath || target.targetKey || 'file'}" (Strategy: ${patchResult.matchType})`
        )

        return {
          version: writeResult.version,
          before: rawContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
          after: patchResult.newContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
        }
      }
    }
  })
}

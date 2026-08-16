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
  }
}

/**
 * DeepSeek Harness Micro-surgical Code Patching Service.
 */
export class SmartPatchService extends Service<SmartPatchConfig> {
  constructor(ctx: Context, config: SmartPatchConfig = {}) {
    super(ctx, 'smartPatch', true)
    this.config = config
  }

  private validatePath(filePath: string): string {
    const cwd = this.config.workspaceRoot || process.cwd()
    const resolved = path.resolve(cwd, filePath)
    const normResolved = path.normalize(resolved).toLowerCase()
    const normRoot = path.normalize(cwd).toLowerCase()

    // Proper path segment boundary check (prevents D:\work2 bypass when root is D:\work)
    const isInside = normResolved === normRoot || normResolved.startsWith(normRoot.endsWith(path.sep) ? normRoot : `${normRoot}${path.sep}`)

    if (!isInside) {
      throw new Error(`Access denied: Target path '${filePath}' is outside workspace root '${cwd}'.`)
    }
    return resolved
  }

  /**
   * Apply single replacement chunk to target file path with workspace safety checks.
   */
  public async replaceInFile(
    filePath: string,
    targetContent: string,
    replacementContent: string
  ): Promise<{ success: boolean; message: string; matchType?: string }> {
    let resolvedPath: string
    try {
      resolvedPath = this.validatePath(filePath)
    } catch (err: any) {
      return { success: false, message: err.message }
    }

    let fileText: string
    try {
      fileText = await fs.readFile(resolvedPath, 'utf-8')
    } catch (err) {
      return { success: false, message: `Failed to read file '${filePath}': ${err}` }
    }

    const result = FuzzyPatchEngine.applyReplacement(fileText, targetContent, replacementContent)
    if (!result.success) {
      return { success: false, message: result.error || 'Patch failed to match target block.' }
    }

    if (this.config.createBackup) {
      try {
        await fs.writeFile(`${resolvedPath}.bak`, fileText, 'utf-8')
      } catch (err) {
        return { success: false, message: `Backup creation failed for '${filePath}': ${err}` }
      }
    }

    const tmpPath = `${resolvedPath}.tmp.${Date.now()}`
    try {
      await fs.writeFile(tmpPath, result.newContent, 'utf-8')
      await fs.rename(tmpPath, resolvedPath)
    } catch (err) {
      try { await fs.unlink(tmpPath) } catch {}
      return { success: false, message: `Failed to commit patch to '${filePath}': ${err}` }
    }

    return {
      success: true,
      message: `Successfully applied micro-surgical patch to '${filePath}' (Match strategy: ${result.matchType}).`,
      matchType: result.matchType,
    }
  }

  /**
   * Apply multiple non-contiguous replacement chunks in transactional order.
   */
  public async multiReplaceInFile(
    filePath: string,
    chunks: ReplacementChunk[]
  ): Promise<{ success: boolean; message: string; appliedChunks: number }> {
    let resolvedPath: string
    try {
      resolvedPath = this.validatePath(filePath)
    } catch (err: any) {
      return { success: false, message: err.message, appliedChunks: 0 }
    }

    let fileText: string
    try {
      fileText = await fs.readFile(resolvedPath, 'utf-8')
    } catch (err) {
      return { success: false, message: `Failed to read file '${filePath}': ${err}`, appliedChunks: 0 }
    }

    const result = FuzzyPatchEngine.applyMultiReplacement(fileText, chunks)
    if (!result.success) {
      return { success: false, message: result.error || 'Multi-patch failed.', appliedChunks: result.appliedChunks }
    }

    if (this.config.createBackup) {
      try {
        await fs.writeFile(`${resolvedPath}.bak`, fileText, 'utf-8')
      } catch (err) {
        return { success: false, message: `Backup creation failed for '${filePath}': ${err}`, appliedChunks: 0 }
      }
    }

    const tmpPath = `${resolvedPath}.tmp.${Date.now()}`
    try {
      await fs.writeFile(tmpPath, result.newContent, 'utf-8')
      await fs.rename(tmpPath, resolvedPath)
    } catch (err) {
      try { await fs.unlink(tmpPath) } catch {}
      return { success: false, message: `Failed to commit multi-patch to '${filePath}': ${err}`, appliedChunks: 0 }
    }

    return {
      success: true,
      message: `Successfully applied ${result.appliedChunks} micro-surgical patch chunks to '${filePath}'.`,
      appliedChunks: result.appliedChunks,
    }
  }
}

export { FuzzyPatchEngine, PatchMatchResult, ReplacementChunk }

export default function apply(ctx: Context, config: SmartPatchConfig = {}) {
  ctx.plugin(SmartPatchService, config)
  ctx.on('ready', () => {
    ctx.logger.info('[dsh-plugin-smart-patch] 4-tier micro-surgical diff engine ready.')
  })
}

import { Context, Service, Schema } from 'cordis'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { FuzzyPatchEngine, PatchMatchResult, ReplacementChunk } from './fuzzy.js'

export interface SmartPatchConfig {
  /** Create automatic .bak backup files before modifying. Default: false */
  createBackup?: boolean
}

export const SmartPatchConfig: Schema<SmartPatchConfig> = Schema.object({
  createBackup: Schema.boolean().default(false).description('Create .bak backup files before applying patches.'),
})

declare module 'cordis' {
  interface Context {
    smartPatch: SmartPatchService
  }
}

/**
 * DeepSeek Harness Micro-surgical Code Patching Service.
 */
export class SmartPatchService extends Service {
  constructor(ctx: Context, private config: SmartPatchConfig = {}) {
    super(ctx, 'smartPatch', true)
  }

  /**
   * Apply single replacement chunk to target file path.
   */
  public async replaceInFile(
    filePath: string,
    targetContent: string,
    replacementContent: string
  ): Promise<{ success: boolean; message: string; matchType?: string }> {
    const resolvedPath = path.resolve(process.cwd(), filePath)

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
      await fs.writeFile(`${resolvedPath}.bak`, fileText, 'utf-8').catch(() => {})
    }

    await fs.writeFile(resolvedPath, result.newContent, 'utf-8')

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
    const resolvedPath = path.resolve(process.cwd(), filePath)

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
      await fs.writeFile(`${resolvedPath}.bak`, fileText, 'utf-8').catch(() => {})
    }

    await fs.writeFile(resolvedPath, result.newContent, 'utf-8')

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

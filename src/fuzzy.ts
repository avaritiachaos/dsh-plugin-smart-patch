/**
 * Shion-inspired 4-tier micro-surgical fuzzy matching engine.
 * 
 * Solves model patch failures caused by indentation drift, whitespace changes, CRLF vs LF, or minor line variance.
 */

export interface PatchMatchResult {
  success: boolean
  startLine: number
  endLine: number
  matchedContent: string
  matchType: 'exact' | 'whitespace-normalized' | 'anchor-based' | 'fuzzy-levenshtein' | 'none'
  confidence: number
}

export interface ReplacementChunk {
  targetContent: string
  replacementContent: string
}

function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length
  const n = s2.length
  const d: number[][] = []

  for (let i = 0; i <= m; i++) d[i] = [i]
  for (let j = 0; j <= n; j++) d[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
    }
  }

  return d[m][n]
}

export class FuzzyPatchEngine {
  /**
   * Locate the exact target line range in the file content using 4-tier cascading matching.
   */
  public static findMatch(fileContent: string, targetBlock: string): PatchMatchResult {
    const fileLines = fileContent.replace(/\r\n/g, '\n').split('\n')
    const targetLines = targetBlock.replace(/\r\n/g, '\n').split('\n')

    if (targetLines.length === 0 || !targetBlock.trim()) {
      return { success: false, startLine: -1, endLine: -1, matchedContent: '', matchType: 'none', confidence: 0 }
    }

    // ── Tier 1: Exact Substring Matching ──────────────────────────────
    const exactIndex = fileContent.indexOf(targetBlock)
    if (exactIndex !== -1) {
      const before = fileContent.slice(0, exactIndex)
      const startLine = before.split('\n').length
      const endLine = startLine + targetLines.length - 1
      return {
        success: true,
        startLine,
        endLine,
        matchedContent: targetBlock,
        matchType: 'exact',
        confidence: 1.0,
      }
    }

    // ── Tier 2: Whitespace-Normalized Line Matching ────────────────────
    const normFileLines = fileLines.map((l) => l.trim())
    const normTargetLines = targetLines.map((l) => l.trim())

    for (let i = 0; i <= normFileLines.length - normTargetLines.length; i++) {
      let match = true
      for (let j = 0; j < normTargetLines.length; j++) {
        if (normFileLines[i + j] !== normTargetLines[j]) {
          match = false
          break
        }
      }
      if (match) {
        const startLine = i + 1
        const endLine = i + normTargetLines.length
        const matchedContent = fileLines.slice(i, i + normTargetLines.length).join('\n')
        return {
          success: true,
          startLine,
          endLine,
          matchedContent,
          matchType: 'whitespace-normalized',
          confidence: 0.95,
        }
      }
    }

    // ── Tier 3: Unique Anchor-Based Boundary Match ─────────────────────
    if (targetLines.length >= 3) {
      const firstLineNorm = targetLines[0].trim()
      const lastLineNorm = targetLines[targetLines.length - 1].trim()

      if (firstLineNorm && lastLineNorm) {
        const potentialStarts: number[] = []
        normFileLines.forEach((line, idx) => {
          if (line === firstLineNorm) potentialStarts.push(idx)
        })

        if (potentialStarts.length === 1) {
          const startIdx = potentialStarts[0]
          const expectedEndIdx = startIdx + targetLines.length - 1
          if (expectedEndIdx < normFileLines.length && normFileLines[expectedEndIdx] === lastLineNorm) {
            return {
              success: true,
              startLine: startIdx + 1,
              endLine: expectedEndIdx + 1,
              matchedContent: fileLines.slice(startIdx, expectedEndIdx + 1).join('\n'),
              matchType: 'anchor-based',
              confidence: 0.88,
            }
          }
        }
      }
    }

    // ── Tier 4: Levenshtein Distance Window Match ──────────────────────
    const targetJoined = normTargetLines.join('\n')
    let bestDist = Infinity
    let bestStart = -1

    for (let i = 0; i <= normFileLines.length - normTargetLines.length; i++) {
      const windowJoined = normFileLines.slice(i, i + normTargetLines.length).join('\n')
      const dist = levenshteinDistance(targetJoined, windowJoined)
      if (dist < bestDist) {
        bestDist = dist
        bestStart = i
      }
    }

    const similarity = 1 - bestDist / Math.max(targetJoined.length, 1)
    if (similarity >= 0.82 && bestStart !== -1) {
      return {
        success: true,
        startLine: bestStart + 1,
        endLine: bestStart + normTargetLines.length,
        matchedContent: fileLines.slice(bestStart, bestStart + normTargetLines.length).join('\n'),
        matchType: 'fuzzy-levenshtein',
        confidence: Number(similarity.toFixed(2)),
      }
    }

    return { success: false, startLine: -1, endLine: -1, matchedContent: '', matchType: 'none', confidence: 0 }
  }

  /**
   * Apply replacement block into file content with safe atomic substitution.
   */
  public static applyReplacement(
    fileContent: string,
    targetBlock: string,
    replacementBlock: string
  ): { success: boolean; newContent: string; matchType: string; error?: string } {
    const match = FuzzyPatchEngine.findMatch(fileContent, targetBlock)
    if (!match.success) {
      return {
        success: false,
        newContent: fileContent,
        matchType: 'none',
        error: 'Target code block could not be located in file (even with 4-tier fuzzy matching).',
      }
    }

    const lines = fileContent.replace(/\r\n/g, '\n').split('\n')
    const beforeLines = lines.slice(0, match.startLine - 1)
    const afterLines = lines.slice(match.endLine)

    const repLines = replacementBlock.replace(/\r\n/g, '\n').split('\n')
    const resultLines = [...beforeLines, ...repLines, ...afterLines]

    return {
      success: true,
      newContent: resultLines.join('\n'),
      matchType: match.matchType,
    }
  }

  /**
   * Apply multiple non-contiguous replacement chunks in transactional order.
   */
  public static applyMultiReplacement(
    fileContent: string,
    chunks: ReplacementChunk[]
  ): { success: boolean; newContent: string; appliedChunks: number; error?: string } {
    let current = fileContent
    let applied = 0

    for (const chunk of chunks) {
      const result = this.applyReplacement(current, chunk.targetContent, chunk.replacementContent)
      if (!result.success) {
        return {
          success: false,
          newContent: fileContent, // Rollback to original
          appliedChunks: applied,
          error: `Chunk #${applied + 1} failed: ${result.error}`,
        }
      }
      current = result.newContent
      applied++
    }

    return { success: true, newContent: current, appliedChunks: applied }
  }
}

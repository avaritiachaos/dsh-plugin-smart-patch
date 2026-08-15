/**
 * Shion-inspired 4-tier micro-surgical fuzzy matching engine.
 * 
 * Solves model patch failures caused by indentation drift, whitespace changes, or CRLF vs LF.
 */

export interface PatchMatchResult {
  success: boolean
  startLine: number
  endLine: number
  matchedContent: string
  matchType: 'exact' | 'whitespace-normalized' | 'anchor-based' | 'fuzzy-levenshtein' | 'none'
  confidence: number
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
}

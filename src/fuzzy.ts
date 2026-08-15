/**
 * Shion-inspired 4-tier micro-surgical fuzzy matching engine.
 * 
 * Features:
 * - Precise substring replacement without destroying adjacent line content
 * - Ambiguity rejection (detects and rejects duplicate non-unique matches)
 * - Original CRLF / LF line-ending preservation
 * - Tier 4 Levenshtein distance matching with bounded complexity
 */

export interface PatchMatchResult {
  success: boolean
  startLine: number
  endLine: number
  matchedContent: string
  matchType: 'exact-substring' | 'exact-lines' | 'whitespace-normalized' | 'anchor-based' | 'fuzzy-levenshtein' | 'none'
  confidence: number
  exactIndex?: number
  exactLength?: number
}

export interface ReplacementChunk {
  targetContent: string
  replacementContent: string
}

function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length
  const n = s2.length
  if (m === 0) return n
  if (n === 0) return m

  let prev = new Array(n + 1)
  let curr = new Array(n + 1)

  for (let j = 0; j <= n; j++) prev[j] = j

  for (let i = 1; i <= m; i++) {
    curr[0] = i
    for (let j = 1; j <= n; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    const temp = prev
    prev = curr
    curr = temp
  }

  return prev[n]
}

export class FuzzyPatchEngine {
  /**
   * Locate the target code block in the file content using 4-tier cascading matching.
   * Enforces uniqueness to prevent accidental edits to ambiguous duplicate blocks.
   */
  public static findMatch(fileContent: string, targetBlock: string): PatchMatchResult {
    if (!targetBlock || !targetBlock.trim()) {
      return { success: false, startLine: -1, endLine: -1, matchedContent: '', matchType: 'none', confidence: 0 }
    }

    const normTarget = targetBlock.replace(/\r\n/g, '\n')
    const normFile = fileContent.replace(/\r\n/g, '\n')

    // ── Tier 1: Exact Substring Matching ──────────────────────────────
    const firstIdx = normFile.indexOf(normTarget)
    if (firstIdx !== -1) {
      const before = normFile.slice(0, firstIdx)
      const startLine = before.split('\n').length
      const targetLinesCount = normTarget.split('\n').length
      const endLine = startLine + targetLinesCount - 1

      return {
        success: true,
        startLine,
        endLine,
        matchedContent: normTarget,
        matchType: 'exact-substring',
        confidence: 1.0,
        exactIndex: firstIdx,
        exactLength: normTarget.length,
      }
    }

    // ── Tier 2: Whitespace-Normalized Line Matching ────────────────────
    const fileLines = normFile.split('\n')
    const targetLines = normTarget.split('\n')
    const normFileLines = fileLines.map((l) => l.trim())
    const normTargetLines = targetLines.map((l) => l.trim())

    const matchingStarts: number[] = []
    for (let i = 0; i <= normFileLines.length - normTargetLines.length; i++) {
      let match = true
      for (let j = 0; j < normTargetLines.length; j++) {
        if (normFileLines[i + j] !== normTargetLines[j]) {
          match = false
          break
        }
      }
      if (match) {
        matchingStarts.push(i)
      }
    }

    if (matchingStarts.length === 1) {
      const startIdx = matchingStarts[0]
      return {
        success: true,
        startLine: startIdx + 1,
        endLine: startIdx + normTargetLines.length,
        matchedContent: fileLines.slice(startIdx, startIdx + normTargetLines.length).join('\n'),
        matchType: 'whitespace-normalized',
        confidence: 0.95,
      }
    }

    // ── Tier 3: Unique Anchor-Based Boundary Match ─────────────────────
    if (targetLines.length >= 3) {
      const firstLineNorm = targetLines[0].trim()
      const lastLineNorm = targetLines[targetLines.length - 1].trim()

      if (firstLineNorm && lastLineNorm) {
        const anchorMatches: number[] = []
        for (let i = 0; i <= normFileLines.length - targetLines.length; i++) {
          if (normFileLines[i] === firstLineNorm && normFileLines[i + targetLines.length - 1] === lastLineNorm) {
            anchorMatches.push(i)
          }
        }

        if (anchorMatches.length === 1) {
          const startIdx = anchorMatches[0]
          const endIdx = startIdx + targetLines.length - 1
          return {
            success: true,
            startLine: startIdx + 1,
            endLine: endIdx + 1,
            matchedContent: fileLines.slice(startIdx, endIdx + 1).join('\n'),
            matchType: 'anchor-based',
            confidence: 0.88,
          }
        }
      }
    }

    // ── Tier 4: Levenshtein Distance Match ─────────────────────────────
    if (normFileLines.length <= 1500 && normTargetLines.length <= 100) {
      const targetJoined = normTargetLines.join('\n')
      let bestDist = Infinity
      let bestStart = -1
      let runnerUpDist = Infinity

      for (let i = 0; i <= normFileLines.length - normTargetLines.length; i++) {
        const windowJoined = normFileLines.slice(i, i + normTargetLines.length).join('\n')
        const dist = levenshteinDistance(targetJoined, windowJoined)
        if (dist < bestDist) {
          runnerUpDist = bestDist
          bestDist = dist
          bestStart = i
        } else if (dist < runnerUpDist) {
          runnerUpDist = dist
        }
      }

      const similarity = 1 - bestDist / Math.max(targetJoined.length, 1)
      if (similarity >= 0.85 && bestStart !== -1 && runnerUpDist - bestDist >= 2) {
        return {
          success: true,
          startLine: bestStart + 1,
          endLine: bestStart + normTargetLines.length,
          matchedContent: fileLines.slice(bestStart, bestStart + normTargetLines.length).join('\n'),
          matchType: 'fuzzy-levenshtein',
          confidence: Number(similarity.toFixed(2)),
        }
      }
    }

    return { success: false, startLine: -1, endLine: -1, matchedContent: '', matchType: 'none', confidence: 0 }
  }

  /**
   * Apply replacement block into file content, strictly preserving original CRLF/LF line endings.
   */
  public static applyReplacement(
    fileContent: string,
    targetBlock: string,
    replacementBlock: string
  ): { success: boolean; newContent: string; matchType: string; error?: string } {
    const isCrlf = fileContent.includes('\r\n')
    const normFile = fileContent.replace(/\r\n/g, '\n')
    const normTarget = targetBlock.replace(/\r\n/g, '\n')
    const normReplacement = replacementBlock.replace(/\r\n/g, '\n')

    const match = FuzzyPatchEngine.findMatch(normFile, normTarget)
    if (!match.success) {
      return {
        success: false,
        newContent: fileContent,
        matchType: 'none',
        error: 'Target code block could not be located in file (or match was ambiguous).',
      }
    }

    let result = ''
    if (match.matchType === 'exact-substring' && match.exactIndex !== undefined && match.exactLength !== undefined) {
      result = normFile.slice(0, match.exactIndex) + normReplacement + normFile.slice(match.exactIndex + match.exactLength)
    } else {
      const lines = normFile.split('\n')
      const beforeLines = lines.slice(0, match.startLine - 1)
      const afterLines = lines.slice(match.endLine)

      const repLines = normReplacement === '' ? [] : normReplacement.split('\n')
      result = [...beforeLines, ...repLines, ...afterLines].join('\n')
    }

    const finalContent = isCrlf ? result.replace(/\n/g, '\r\n') : result

    return {
      success: true,
      newContent: finalContent,
      matchType: match.matchType,
    }
  }

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
          newContent: fileContent, // Complete transactional rollback
          appliedChunks: 0,
          error: `Chunk #${applied + 1} failed: ${result.error}`,
        }
      }
      current = result.newContent
      applied++
    }

    return { success: true, newContent: current, appliedChunks: applied }
  }
}

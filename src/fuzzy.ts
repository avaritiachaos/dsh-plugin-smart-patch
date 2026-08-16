/**
 * 4-tier micro-surgical fuzzy patch engine.
 *
 * Features:
 * - Precise substring replacement without destroying adjacent line content
 * - Ambiguity rejection (detects and rejects duplicate non-unique matches across all tiers)
 * - Per-line CRLF / LF preservation: unmodified lines keep their exact original
 *   line terminators, mixed-EOL files stay mixed (M13)
 * - exactIndex/exactLength are reported in *original* file coordinates (M17)
 * - Tier 3 anchor matching verifies the middle content instead of trusting
 *   first/last anchors alone (C6)
 * - Tier 4 Levenshtein matching bounded by both line count and total chars (M13b)
 */
export interface PatchMatchResult {
  success: boolean
  startLine: number
  endLine: number
  matchedContent: string
  matchType:
    | 'exact'
    | 'exact-substring'
    | 'whitespace-normalized'
    | 'anchor-based'
    | 'fuzzy-levenshtein'
    | 'none'
  confidence: number
  /** 0-based index of the match in ORIGINAL file coordinates (exact tiers only). */
  exactIndex?: number
  /** length of the match in ORIGINAL file coordinates (exact tiers only). */
  exactLength?: number
  error?: string
}

export interface ReplacementChunk {
  targetContent: string
  replacementContent: string
}

const TIER3_MIN_MIDDLE_RATIO = 0.6 // fraction of middle lines that must match for anchor tier
const TIER4_MAX_FILE_LINES = 1500
const TIER4_MAX_TARGET_LINES = 100
const TIER4_MAX_FILE_CHARS = 200_000
const TIER4_MAX_TARGET_CHARS = 20_000

/** Split file into (content, terminator) tokens, terminators kept. */
function tokenizeLines(text: string): string[] {
  return text.split(/(\r\n|\n|\r)/)
}

/** Most frequent line terminator in a file ('\r\n' | '\n' | '\r'), default '\n'. */
function dominantEol(text: string): string {
  const crlf = (text.match(/\r\n/g) || []).length
  const lf = (text.match(/(?<!\r)\n/g) || []).length
  const cr = (text.match(/\r(?!\n)/g) || []).length
  const best = Math.max(crlf, lf, cr)
  if (best === 0) return '\n'
  if (best === crlf) return '\r\n'
  if (best === cr) return '\r'
  return '\n'
}

/** Normalize a block's EOLs to the given style. */
function normalizeToEol(text: string, eol: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').join(eol)
}

export class FuzzyPatchEngine {
  /**
   * Find the best matching location for `targetBlock` inside `fileContent`.
   *
   * Returns `success: false` (with `error`) when the target cannot be located
   * uniquely — including ambiguous multi-candidate situations.
   */
  public static findMatch(fileContent: string, targetBlock: string): PatchMatchResult {
    if (!targetBlock || !targetBlock.trim()) {
      return { success: false, startLine: -1, endLine: -1, matchedContent: '', matchType: 'none', confidence: 0, error: 'Empty target block.' }
    }

    // Normalize CRLF/CR to LF while remembering the original position of every
    // normalized character, so exact coordinates can be reported in the
    // original string (M17).
    const normChars: string[] = []
    const origMap: number[] = [] // origMap[i] = original index of normalized char i
    for (let i = 0; i < fileContent.length; i++) {
      const ch = fileContent[i]
      if (ch === '\r') {
        if (fileContent[i + 1] === '\n') {
          normChars.push('\n')
          origMap.push(i)
          i++ // consume the \n of the \r\n pair
        } else {
          normChars.push('\n')
          origMap.push(i)
        }
      } else {
        normChars.push(ch)
        origMap.push(i)
      }
    }
    origMap.push(fileContent.length)
    const normFile = normChars.join('')
    const normTarget = targetBlock.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

    // ── Tier 1: Exact Substring Matching ──────────────────────────────
    const firstIdx = normFile.indexOf(normTarget)
    if (firstIdx !== -1) {
      // Ambiguity check: if targetBlock appears multiple times, reject (C6).
      const secondIdx = normFile.indexOf(normTarget, firstIdx + 1)
      if (secondIdx !== -1) {
        return {
          success: false,
          startLine: -1,
          endLine: -1,
          matchedContent: '',
          matchType: 'none',
          confidence: 0,
          error: 'Ambiguous matches: target block occurs multiple times in file. Please provide more context.',
        }
      }

      const before = normFile.slice(0, firstIdx)
      const startLine = before.split('\n').length
      const targetLinesCount = normTarget.split('\n').length

      return {
        success: true,
        startLine,
        endLine: startLine + targetLinesCount - 1,
        matchedContent: normTarget,
        matchType: 'exact',
        confidence: 1.0,
        exactIndex: origMap[firstIdx],
        exactLength: origMap[firstIdx + normTarget.length] - origMap[firstIdx],
      }
    }

    // ── Tier 2: Whitespace-Normalized Line Matching ────────────────────
    const fileLines = normFile.split('\n')
    const targetLines = normTarget.split('\n')
    const normFileLines = fileLines.map((l) => l.trim())
    const normTargetLines = targetLines.map((l) => l.trim())

    const matchingStarts: number[] = []
    for (let i = 0; i <= normFileLines.length - normTargetLines.length && matchingStarts.length <= 1; i++) {
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
    } else if (matchingStarts.length > 1) {
      return {
        success: false,
        startLine: -1,
        endLine: -1,
        matchedContent: '',
        matchType: 'none',
        confidence: 0,
        error: `Ambiguous matches: found ${matchingStarts.length} identical whitespace-normalized candidates in file.`,
      }
    }

    // ── Tier 3: Unique Anchor-Based Boundary Match ─────────────────────
    if (targetLines.length >= 3) {
      const firstLineNorm = targetLines[0].trim()
      const lastLineNorm = targetLines[targetLines.length - 1].trim()
      const targetMiddle = targetLines.slice(1, -1).map((l) => l.trim())

      if (firstLineNorm && lastLineNorm) {
        const anchorMatches: number[] = []
        for (let i = 0; i <= normFileLines.length - targetLines.length && anchorMatches.length <= 1; i++) {
          if (normFileLines[i] !== firstLineNorm || normFileLines[i + targetLines.length - 1] !== lastLineNorm) {
            continue
          }
          // Verify the middle content instead of trusting anchors alone (C6):
          // a candidate passes only if most middle lines match (trimmed).
          if (targetMiddle.length > 0) {
            let same = 0
            for (let j = 0; j < targetMiddle.length; j++) {
              if (normFileLines[i + 1 + j] === targetMiddle[j]) same++
            }
            if (same / targetMiddle.length < TIER3_MIN_MIDDLE_RATIO) continue
          }
          anchorMatches.push(i)
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
        } else if (anchorMatches.length > 1) {
          return {
            success: false,
            startLine: -1,
            endLine: -1,
            matchedContent: '',
            matchType: 'none',
            confidence: 0,
            error: 'Ambiguous matches: multiple anchor-based candidates with matching middle content found.',
          }
        }
      }
    }

    // ── Tier 4: Levenshtein Distance Match ─────────────────────────────
    const contentLineCount = normFile.replace(/\n+$/, '').split('\n').length
    const normText = normFileLines.join('\n')
    const targetText = normTargetLines.join('\n')
    if (
      contentLineCount <= TIER4_MAX_FILE_LINES &&
      normTargetLines.length <= TIER4_MAX_TARGET_LINES &&
      normText.length <= TIER4_MAX_FILE_CHARS &&
      targetText.length <= TIER4_MAX_TARGET_CHARS
    ) {
      const targetJoined = targetText
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

    return { success: false, startLine: -1, endLine: -1, matchedContent: '', matchType: 'none', confidence: 0, error: 'Target code block could not be located in file.' }
  }

  /**
   * Apply replacement block into file content, preserving each unmodified
   * line's original CRLF/LF terminator (mixed-EOL files stay mixed, M13).
   * The replacement block itself uses the file's dominant EOL style.
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
        error: match.error || 'Target code block could not be located in file.',
      }
    }

    const eol = dominantEol(fileContent)
    const repl = normalizeToEol(replacementBlock, eol)

    // Exact tier: coordinates are already in original-file space (M17).
    if ((match.matchType === 'exact' || match.matchType === 'exact-substring') && match.exactIndex !== undefined && match.exactLength !== undefined) {
      return {
        success: true,
        newContent: fileContent.slice(0, match.exactIndex) + repl + fileContent.slice(match.exactIndex + match.exactLength),
        matchType: match.matchType,
      }
    }

    // Line tiers: replace only the content tokens of the matched lines,
    // leaving every original terminator (and all other lines) untouched.
    const tokens = tokenizeLines(fileContent)
    const startTok = 2 * (match.startLine - 1)
    const endTok = 2 * (match.endLine - 1)
    if (startTok < 0 || endTok >= tokens.length) {
      return {
        success: false,
        newContent: fileContent,
        matchType: 'none',
        error: `Line range ${match.startLine}-${match.endLine} is out of bounds for this file.`,
      }
    }

    return {
      success: true,
      newContent: tokens.slice(0, startTok).join('') + repl + tokens.slice(endTok + 1).join(''),
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

/** Classic dynamic-programming Levenshtein distance. */
function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

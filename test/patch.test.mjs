import test from 'node:test'
import assert from 'node:assert/strict'

class FuzzyPatchEngine {
  static findMatch(fileContent, targetBlock) {
    const fileLines = fileContent.replace(/\r\n/g, '\n').split('\n')
    const targetLines = targetBlock.replace(/\r\n/g, '\n').split('\n')

    if (targetLines.length === 0 || !targetBlock.trim()) {
      return { success: false, startLine: -1, endLine: -1, matchedContent: '', matchType: 'none' }
    }

    // Tier 1: Exact Match
    const exactIndex = fileContent.indexOf(targetBlock)
    if (exactIndex !== -1) {
      const before = fileContent.slice(0, exactIndex)
      const startLine = before.split('\n').length
      const endLine = startLine + targetLines.length - 1
      return { success: true, startLine, endLine, matchedContent: targetBlock, matchType: 'exact' }
    }

    // Tier 2: Whitespace-Normalized Line Matching
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
        return {
          success: true,
          startLine: i + 1,
          endLine: i + normTargetLines.length,
          matchedContent: fileLines.slice(i, i + normTargetLines.length).join('\n'),
          matchType: 'whitespace-normalized',
        }
      }
    }

    // Tier 3: Anchor-based match
    if (targetLines.length >= 3) {
      const firstLineNorm = targetLines[0].trim()
      const lastLineNorm = targetLines[targetLines.length - 1].trim()
      const potentialStarts = []
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
          }
        }
      }
    }

    return { success: false, startLine: -1, endLine: -1, matchedContent: '', matchType: 'none' }
  }

  static applyReplacement(fileContent, targetBlock, replacementBlock) {
    const match = FuzzyPatchEngine.findMatch(fileContent, targetBlock)
    if (!match.success) return { success: false, newContent: fileContent }
    const lines = fileContent.replace(/\r\n/g, '\n').split('\n')
    const beforeLines = lines.slice(0, match.startLine - 1)
    const afterLines = lines.slice(match.endLine)
    const repLines = replacementBlock.replace(/\r\n/g, '\n').split('\n')
    return {
      success: true,
      newContent: [...beforeLines, ...repLines, ...afterLines].join('\n'),
      matchType: match.matchType,
    }
  }
}

test('FuzzyPatchEngine performs exact substring replacement', () => {
  const original = `function add(a, b) {\n  return a + b\n}`
  const target = `  return a + b`
  const replacement = `  return (a + b) * 2`

  const result = FuzzyPatchEngine.applyReplacement(original, target, replacement)
  assert.ok(result.success)
  assert.equal(result.matchType, 'exact')
  assert.equal(result.newContent, `function add(a, b) {\n  return (a + b) * 2\n}`)
})

test('FuzzyPatchEngine survives indentation drift and whitespace difference', () => {
  const original = `    function greet() {\n        console.log("hi")\n    }`
  // Model provided 2-space indentation instead of 4-space
  const target = `  function greet() {\n    console.log("hi")\n  }`
  const replacement = `    function greet() {\n        console.log("hello world")\n    }`

  const result = FuzzyPatchEngine.applyReplacement(original, target, replacement)
  assert.ok(result.success)
  assert.equal(result.matchType, 'whitespace-normalized')
  assert.ok(result.newContent.includes('hello world'))
})

test('FuzzyPatchEngine uses unique anchors for block replacement', () => {
  const original = `class Controller {\n  init() {\n    // Setup\n    this.ready = true\n  }\n}`
  const target = `  init() {\n    // Different comment\n    this.ready = true\n  }`
  const replacement = `  init() {\n    this.ready = false\n  }`

  const result = FuzzyPatchEngine.applyReplacement(original, target, replacement)
  assert.ok(result.success)
  assert.equal(result.matchType, 'anchor-based')
  assert.ok(result.newContent.includes('this.ready = false'))
})

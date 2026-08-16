import test from 'node:test'
import assert from 'node:assert'
import { FuzzyPatchEngine } from '../src/fuzzy.ts'

test('FuzzyPatchEngine preserves inline prefix and suffix during substring replacement', () => {
  const original = 'const prefix = true; return a + b; const suffix = true;'
  const target = 'return a + b'
  const replacement = 'return a * b'

  const res = FuzzyPatchEngine.applyReplacement(original, target, replacement)
  assert.strictEqual(res.success, true)
  assert.strictEqual(res.matchType, 'exact')
  assert.strictEqual(res.newContent, 'const prefix = true; return a * b; const suffix = true;')
})

test('FuzzyPatchEngine rejects ambiguous duplicate exact blocks', () => {
  const duplicateCode = 'function a() { return 1; }\nfunction b() { return 1; }'
  const ambiguousTarget = 'return 1;'
  const replacement = 'return 2;'

  const res = FuzzyPatchEngine.applyReplacement(duplicateCode, ambiguousTarget, replacement)
  assert.strictEqual(res.success, false)
  assert.strictEqual(res.error.includes('Ambiguous'), true)
})

test('FuzzyPatchEngine preserves CRLF line endings', () => {
  const crlfOriginal = 'function hello() {\r\n  console.log("old");\r\n}\r\n'
  const target = 'console.log("old");'
  const replacement = 'console.log("new");'

  const res = FuzzyPatchEngine.applyReplacement(crlfOriginal, target, replacement)
  assert.strictEqual(res.success, true)
  assert.strictEqual(res.newContent.includes('\r\n'), true)
  assert.strictEqual(res.newContent, 'function hello() {\r\n  console.log("new");\r\n}\r\n')
})

test('FuzzyPatchEngine survives indentation drift and whitespace differences', () => {
  const original = 'class Engine {\n    start() {\n        this.running = true;\n    }\n}'
  const target = '  start() {\n      this.running = true;\n  }'
  const replacement = '  start() {\n    this.running = true;\n    this.init();\n  }'

  const res = FuzzyPatchEngine.applyReplacement(original, target, replacement)
  assert.strictEqual(res.success, true)
  assert.strictEqual(res.matchType, 'whitespace-normalized')
  assert.strictEqual(res.newContent.includes('this.init()'), true)
})

test('FuzzyPatchEngine applies multi-chunk replacements transactionally and rolls back on failure', () => {
  const original = 'line1\nline2\nline3'
  const chunks = [
    { targetContent: 'line1', replacementContent: 'chunk1' },
    { targetContent: 'non_existent_line', replacementContent: 'chunk2' },
  ]

  const res = FuzzyPatchEngine.applyMultiReplacement(original, chunks)
  assert.strictEqual(res.success, false)
  assert.strictEqual(res.appliedChunks, 0)
  assert.strictEqual(res.newContent, original) // Rolled back!
})

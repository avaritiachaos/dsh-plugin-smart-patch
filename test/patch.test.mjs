import test from 'node:test'
import assert from 'node:assert'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { Context } from 'cordis'
import { FuzzyPatchEngine, SmartPatchConfig, SmartPatchService } from '../dist/index.js'

// ── engine: exact & ambiguity ───────────────────────────────────────────────

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
  const res = FuzzyPatchEngine.applyReplacement(duplicateCode, 'return 1;', 'return 2;')
  assert.strictEqual(res.success, false)
  assert.strictEqual(res.error.includes('Ambiguous'), true)
})

test('FuzzyPatchEngine reports exactIndex in original-file coordinates (M17)', () => {
  const match = FuzzyPatchEngine.findMatch('a\r\nb\r\n', 'b')
  assert.strictEqual(match.success, true)
  assert.strictEqual(match.exactIndex, 3) // 'a','\r','\n','b' -> index 3, not the normalized index 2
  assert.strictEqual(match.exactLength, 1)
})

// ── engine: EOL fidelity (M13) ─────────────────────────────────────────────

test('FuzzyPatchEngine preserves mixed CRLF/LF per line (M13)', () => {
  const mixed = 'a\r\nb\nc\r\n'
  const res = FuzzyPatchEngine.applyReplacement(mixed, 'b', 'B')
  assert.strictEqual(res.success, true)
  // unchanged lines keep their own terminators; only 'b' is replaced
  assert.strictEqual(res.newContent, 'a\r\nB\nc\r\n')
})

test('FuzzyPatchEngine applies the file-dominant EOL to multi-line replacements', () => {
  const mixed = 'a\r\nb\nc\r\n'
  const res = FuzzyPatchEngine.applyReplacement(mixed, 'b', 'B1\nB2')
  assert.strictEqual(res.success, true)
  assert.strictEqual(res.newContent, 'a\r\nB1\r\nB2\nc\r\n')
})

test('FuzzyPatchEngine preserves CRLF line endings', () => {
  const crlfOriginal = 'function hello() {\r\n  console.log("old");\r\n}\r\n'
  const res = FuzzyPatchEngine.applyReplacement(crlfOriginal, 'console.log("old");', 'console.log("new");')
  assert.strictEqual(res.success, true)
  assert.strictEqual(res.newContent, 'function hello() {\r\n  console.log("new");\r\n}\r\n')
})

test('FuzzyPatchEngine survives indentation drift and whitespace differences', () => {
  const original = 'class Engine {\n    start() {\n        this.running = true;\n    }\n}'
  const res = FuzzyPatchEngine.applyReplacement(
    original,
    '  start() {\n      this.running = true;\n  }',
    '  start() {\n    this.running = true;\n    this.init();\n  }',
  )
  assert.strictEqual(res.success, true)
  assert.strictEqual(res.matchType, 'whitespace-normalized')
  assert.strictEqual(res.newContent.includes('this.init()'), true)
})

// ── engine: Tier 3 middle verification (C6) ────────────────────────────────

test('FuzzyPatchEngine Tier 3 verifies middle content instead of trusting anchors (C6)', () => {
  // Two blocks share the same anchors; only the first has a qualifying middle
  // (2/3 middle lines match), and no tier above Tier 3 can match.
  const file = 'start\nAAA\nYYY\nMMM\nend\nstart\nBBB\nZZZ\nNNN\nend'
  const target = 'start\nAAA\nXXX\nMMM\nend'
  const res = FuzzyPatchEngine.applyReplacement(file, target, 'start\nAAA\nXXX\nMMM\nend')
  assert.strictEqual(res.success, true)
  assert.strictEqual(res.matchType, 'anchor-based')
  assert.strictEqual(res.newContent, 'start\nAAA\nXXX\nMMM\nend\nstart\nBBB\nZZZ\nNNN\nend')
})

test('FuzzyPatchEngine Tier 3 rejects ambiguity when several middles qualify', () => {
  const file = 'start\nAAA\nYYY\nMMM\nend\nstart\nAAA\nYYY\nMMM\nend'
  const target = 'start\nAAA\nXXX\nMMM\nend'
  const res = FuzzyPatchEngine.applyReplacement(file, target, 'start\nAAA\nXXX\nMMM\nend')
  assert.strictEqual(res.success, false)
  assert.strictEqual(res.error.includes('Ambiguous'), true)
})

test('FuzzyPatchEngine Tier 3 rejects anchors whose middle does not match at all', () => {
  const file = 'start\nAAA\nend\nstart\nBBB\nend'
  const res = FuzzyPatchEngine.applyReplacement(file, 'start\nZZZ\nend', 'start\nXXX\nend')
  assert.strictEqual(res.success, false)
})

test('FuzzyPatchEngine applies multi-chunk replacements transactionally and rolls back on failure', () => {
  const original = 'line1\nline2\nline3'
  const res = FuzzyPatchEngine.applyMultiReplacement(original, [
    { targetContent: 'line1', replacementContent: 'chunk1' },
    { targetContent: 'non_existent_line', replacementContent: 'chunk2' },
  ])
  assert.strictEqual(res.success, false)
  assert.strictEqual(res.appliedChunks, 0)
  assert.strictEqual(res.newContent, original) // Rolled back!
})

// ── service: workspace containment (C4) ────────────────────────────────────

function makeService(root) {
  return new SmartPatchService(new Context(), { workspaceRoot: root })
}

test('SmartPatchService patches inside the workspace and rejects outside paths', async (t) => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-'))
  const root = path.join(parent, 'ws') // workspace root
  const sibling = path.join(parent, 'ws2') // similar-looking sibling OUTSIDE the root
  await fs.mkdir(root)
  await fs.mkdir(sibling)
  await fs.mkdir(path.join(root, 'sub'))
  t.after(() => fs.rm(parent, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'sub', 'a.txt'), 'hello world\n', 'utf-8')
  await fs.writeFile(path.join(sibling, 'a.txt'), 'nope\n', 'utf-8')

  const svc = makeService(root)
  const ok = await svc.replaceInFile('sub/a.txt', 'world', 'dsh')
  assert.strictEqual(ok.success, true)
  assert.strictEqual(await fs.readFile(path.join(root, 'sub', 'a.txt'), 'utf-8'), 'hello dsh\n')

  // segment boundary: D:\ws2 must be denied when root is D:\ws (C4)
  const denied = await svc.replaceInFile(path.join(sibling, 'a.txt'), 'nope', 'yep')
  assert.strictEqual(denied.success, false)
  assert.match(denied.message, /outside workspace root/)
  assert.strictEqual(await fs.readFile(path.join(sibling, 'a.txt'), 'utf-8'), 'nope\n')

  // explicit .. escape
  const escape = await svc.replaceInFile('../escape.txt', 'x', 'y')
  assert.strictEqual(escape.success, false)
})

test('SmartPatchService denies junction/symlink escapes to outside files (C4)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-patch-'))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-outside-'))
  t.after(() => {
    fs.rm(root, { recursive: true, force: true })
    fs.rm(outside, { recursive: true, force: true })
  })
  await fs.writeFile(path.join(outside, 'secret.txt'), 'top secret\n', 'utf-8')

  const svc = makeService(root)

  // 1. junction: root/link -> outside
  await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  const viaJunction = await svc.replaceInFile('link/secret.txt', 'secret', 'LEAKED')
  assert.strictEqual(viaJunction.success, false)
  assert.match(viaJunction.message, /outside workspace root/)
  assert.strictEqual(await fs.readFile(path.join(outside, 'secret.txt'), 'utf-8'), 'top secret\n')

  // 2. file symlink: root/link.txt -> outside/secret.txt (requires admin or
  //    Developer Mode on Windows; skip there)
  try {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'))
  } catch (err) {
    if (process.platform === 'win32' && err.code === 'EPERM') {
      t.skip('file symlinks require admin/Developer Mode on Windows')
      return
    }
    throw err
  }
  const viaFileLink = await svc.replaceInFile('link.txt', 'secret', 'LEAKED')
  assert.strictEqual(viaFileLink.success, false)
  assert.match(viaFileLink.message, /outside workspace root/)
  assert.strictEqual(await fs.readFile(path.join(outside, 'secret.txt'), 'utf-8'), 'top secret\n')
})

// ── service: concurrency & backup safety (C7/M14/M15) ──────────────────────

test('SmartPatchService serializes concurrent patches on the same file (M14)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-patch-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'f.txt')
  await fs.writeFile(file, 'x\ny\nz\n', 'utf-8')

  const svc = makeService(root)
  const [a, b] = await Promise.all([
    svc.replaceInFile('f.txt', 'x', 'X'),
    svc.replaceInFile('f.txt', 'y', 'Y'),
  ])
  assert.strictEqual(a.success, true)
  assert.strictEqual(b.success, true)
  // both patches applied — no lost update
  assert.strictEqual(await fs.readFile(file, 'utf-8'), 'X\nY\nz\n')
})

test('SmartPatchService refuses backups through a pre-existing .bak symlink (C7)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-patch-'))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-outside-'))
  t.after(() => {
    fs.rm(root, { recursive: true, force: true })
    fs.rm(outside, { recursive: true, force: true })
  })
  await fs.writeFile(path.join(root, 'f.txt'), 'content\n', 'utf-8')
  // .bak as a symlink (dir symlink / junction — works without admin on Windows)
  await fs.symlink(outside, path.join(root, 'f.txt.bak'), process.platform === 'win32' ? 'junction' : 'dir')

  const svc = new SmartPatchService(new Context(), { workspaceRoot: root, createBackup: true })
  const res = await svc.replaceInFile('f.txt', 'content', 'changed')
  assert.strictEqual(res.success, false)
  assert.match(res.message, /symlink/)
  // original file untouched
  assert.strictEqual(await fs.readFile(path.join(root, 'f.txt'), 'utf-8'), 'content\n')
})

test('SmartPatchService propagates backup failures and leaves the file untouched (M15)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-patch-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'g.txt'), 'content\n', 'utf-8')
  await fs.mkdir(path.join(root, 'g.txt.bak')) // .bak is a directory -> write fails

  const svc = new SmartPatchService(new Context(), { workspaceRoot: root, createBackup: true })
  const res = await svc.replaceInFile('g.txt', 'content', 'changed')
  assert.strictEqual(res.success, false)
  assert.match(res.message, /Backup creation failed/)
  assert.strictEqual(await fs.readFile(path.join(root, 'g.txt'), 'utf-8'), 'content\n')
})

test('SmartPatchService multiReplaceInFile succeeds transactionally', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-patch-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.writeFile(path.join(root, 'm.txt'), 'a\nb\nc\n', 'utf-8')

  const svc = makeService(root)
  const res = await svc.multiReplaceInFile('m.txt', [
    { targetContent: 'a', replacementContent: 'A' },
    { targetContent: 'c', replacementContent: 'C' },
  ])
  assert.strictEqual(res.success, true)
  assert.strictEqual(res.appliedChunks, 2)
  assert.strictEqual(await fs.readFile(path.join(root, 'm.txt'), 'utf-8'), 'A\nb\nC\n')
})

// ── config schema ──────────────────────────────────────────────────────────

test('SmartPatchConfig applies defaults and rejects invalid values', () => {
  const defaults = SmartPatchConfig({})
  assert.strictEqual(defaults.createBackup, false)
  assert.strictEqual(defaults.workspaceRoot, '')
  assert.throws(() => SmartPatchConfig({ createBackup: 'yes' }))
})

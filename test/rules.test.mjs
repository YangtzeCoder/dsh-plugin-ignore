/**
 * `lib/rules.js` 的语义测试：纯 node 可跑，不依赖任何 DSH 运行时包。
 *   node test/rules.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileRules, createMatcher, createRulesCache, normalizePath } from '../lib/rules.js'

let passed = 0
const test = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    console.error(`FAIL  ${label}`)
    throw error
  }
}

/**
 * 断言一组规则对若干 `路径/类型 → 期望` 的判定。
 * @param {string} label - 用例名。
 * @param {string[]} lines - 规则行。
 * @param {Array<[string, boolean, ('file'|'directory')?]>} cases - `[路径, 期望, 类型]`。
 */
const table = (label, lines, cases) => test(label, () => {
  const matcher = createMatcher(lines)
  for (const [path, expected, kind = 'file'] of cases) {
    assert.equal(
      matcher.ignores(path, kind),
      expected,
      `${lines.join(' ; ')} ⇒ ${path} (${kind}) 期望 ${expected}`,
    )
  }
})

console.log('编译')

test('注释、空行、转义的开头字符', () => {
  const { rules, skipped } = compileRules([
    '# 注释',
    '',
    '   ',
    'dist',
    '\\#literal',
    '\\!bang',
  ])
  assert.deepEqual(rules.map((rule) => rule.glob), ['dist', '#literal', '!bang'])
  assert.deepEqual(skipped, [])
})

test('真正无法使用的行才进 skipped', () => {
  const { rules, skipped } = compileRules(['!', '/', '//', 'ok'])
  assert.deepEqual(rules.map((rule) => rule.glob), ['ok'])
  assert.deepEqual(skipped, ['!', '/', '//'])
})

console.log('匹配语义')

table('纯目录名：任意深度、文件与目录都算', ['dist'], [
  ['dist', true, 'directory'],
  ['a/dist', true, 'directory'],
  ['dist', true, 'file'],
  ['a/b/dist', true, 'file'],
  ['distx', false, 'file'],
  ['src/distance.js', false, 'file'],
])

table('尾斜杠：只匹配目录', ['dist/'], [
  ['dist', true, 'directory'],
  ['a/dist', true, 'directory'],
  ['dist', false, 'file'],
])

table('前导斜杠：锚定到工作区根', ['/dist'], [
  ['dist', true, 'directory'],
  ['a/dist', false, 'directory'],
  ['dist', true, 'file'],
])

table('含斜杠即锚定', ['docs/guide'], [
  ['docs/guide', true, 'file'],
  ['a/docs/guide', false, 'file'],
])

table('通配符不跨目录', ['*.log', 'src/*.js'], [
  ['a.log', true],
  ['x/a.log', true],
  ['a.log.txt', false],
  ['src/main.js', true],
  ['src/deep/main.js', false],
])

table('问号与字符类', ['?at', '[cm]at', '[!c]at', 'file[0-9].txt'], [
  ['cat', true],
  ['at', false],
  ['x/cat', true],
  ['mat', true],
  ['bat', true],
  ['file7.txt', true],
  ['fileX.txt', false],
])

table('** 的三种跨目录形态', ['**/temp', 'build/**', 'a/**/b'], [
  ['temp', true],
  ['x/y/temp', true],
  ['build/out.js', true],
  ['build/a/b/c', true],
  ['build', false],
  ['a/b', true],
  ['a/x/b', true],
  ['a/x/y/b', true],
  ['a/xb', false],
])

table('最后匹配的规则生效', ['*.log', '!keep.log'], [
  ['other.log', true],
  ['keep.log', false],
  ['sub/keep.log', false],
])

table('锚定的取反只作用于根', ['*.md', '!/README.md'], [
  ['README.md', false],
  ['notes.md', true],
  ['docs/README.md', true],
])

table('取反可以重新包含目录，其内容随之放行', ['logs/', '!logs/'], [
  ['logs', false, 'directory'],
  ['logs/x.txt', false],
])

console.log('父目录规则')

table('父目录被排除时无法重新包含其中内容', ['dist/', '!dist/keep.js'], [
  ['dist/keep.js', true],
  ['dist', true, 'directory'],
])

table('父目录未被排除时，取反正常生效', ['dist/', '!packages/a/dist/'], [
  ['dist/x.txt', true],
  ['packages/a/dist/keep.txt', false],
])

console.log('剪枝名单')

test('只收未取反、未锚定、纯字面名字的规则', () => {
  const names = createMatcher(['dist/', 'node_modules', '*.log', '/build', '!keep.log', 'a/b']).promotableDirectories()
  assert.deepEqual([...names].sort(), ['dist', 'node_modules'])
})

test('可能被重新包含的同名目录不剪枝', () => {
  const names = createMatcher(['dist/', '!packages/a/dist/']).promotableDirectories()
  assert.deepEqual([...names], [], 'dist 可能被取反重新包含，不能剪掉')

  const wildcard = createMatcher(['cache/', '!**/cache/']).promotableDirectories()
  assert.deepEqual([...wildcard], [], '取反最后一段是 cache，同样不能剪')
})

test('匹配所有路径的取反会让剪枝整体失效', () => {
  const names = createMatcher(['dist/', 'node_modules', '!**']).promotableDirectories()
  assert.deepEqual([...names], [])
})

console.log('路径归一化')

test('反斜杠、重复斜杠、./ 前缀', () => {
  assert.equal(normalizePath('src\\dist\\a.js'), 'src/dist/a.js')
  assert.equal(normalizePath('./src/a.js'), 'src/a.js')
  assert.equal(normalizePath('//src//a.js//'), 'src/a.js')
  const matcher = createMatcher(['dist/'])
  assert.equal(matcher.ignores('src\\dist\\a.js', 'file'), true)
})

console.log('缓存与配置')

test('文件不存在 → 空规则，且不抛错', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ignore-'))
  try {
    const entry = createRulesCache().lookup(root)
    assert.equal(entry.stamp, 'absent')
    assert.equal(entry.matcher.isEmpty, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('内容变化后失效，未变化时复用同一对象', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ignore-'))
  try {
    const cache = createRulesCache()
    writeFileSync(join(root, '.dshignore'), 'dist\n')
    const first = cache.lookup(root)
    assert.equal(first.matcher.ignores('a/dist', 'directory'), true)
    assert.equal(cache.lookup(root), first, '未变化时应命中缓存')

    writeFileSync(join(root, '.dshignore'), 'dist\nbuild\ncoverage\n')
    const second = cache.lookup(root)
    assert.equal(second.matcher.rules.length, 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('extraPatterns 排在文件规则前面，文件里靠后的规则覆盖它', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ignore-'))
  try {
    const cache = createRulesCache({ extraPatterns: ['*.log'] })
    writeFileSync(join(root, '.dshignore'), '!keep.log\n')
    const matcher = cache.lookup(root).matcher
    assert.equal(matcher.ignores('a.log', 'file'), true)
    assert.equal(matcher.ignores('keep.log', 'file'), false, '文件里的 !keep.log 应覆盖配置里的 *.log')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('extraDirectories 仍可用，等价于一条目录规则', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ignore-'))
  try {
    const matcher = createRulesCache({ extraDirectories: ['tmp'] }).lookup(root).matcher
    assert.equal(matcher.ignores('a/tmp/x.txt', 'file'), true)
    assert.equal(matcher.ignores('tmp', 'file'), false, '只匹配目录')
    assert.deepEqual([...matcher.promotableDirectories()], ['tmp'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('自定义文件名', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ignore-'))
  try {
    writeFileSync(join(root, 'ignore.txt'), 'out\n')
    const entry = createRulesCache({ ignoreFile: 'ignore.txt' }).lookup(root)
    assert.equal(entry.file, join(root, 'ignore.txt'))
    assert.equal(entry.matcher.ignores('out/x.txt', 'file'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

console.log(`\n${passed} 项全部通过`)

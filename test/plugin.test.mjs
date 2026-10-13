/**
 * `lib/index.js` 的接线测试：用假的 `fileReferences` 服务把整条包装逻辑跑通。
 *
 * 因为插件模块已经做到零运行时 import，这里可以用纯 node 直接 import 它，
 * 不需要 DSH 运行时，也不需要 GUI。
 *   node test/plugin.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

let passed = 0
const test = async (label, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    console.error(`FAIL  ${label}`)
    throw error
  }
}

/** 内置 provider 的默认排除名单，测试里当作"provider 自己的配置"用。 */
const BUILTIN_DEFAULTS = ['node_modules', 'dist', 'build']

/**
 * 造一个最小的 `ctx` + `fileReferences` 服务替身。
 * @param {string} cwd - 假 agent 的工作区根。
 * @param {Array<{ path: string, kind: 'file'|'directory' }>} candidates - provider 会返回的候选。
 * @param {{ withSearch?: boolean }} [options] - 是否预置 provider 的 search 实例。
 */
function harness(cwd, candidates, options = {}) {
  const search = {
    excludedDirectories: new Set(BUILTIN_DEFAULTS),
    invalidations: 0,
    invalidate() {
      this.invalidations += 1
    },
  }
  const service = {
    config: { maxResults: 20, maxEntries: 50_000, excludedDirectories: [...BUILTIN_DEFAULTS] },
    searches: new Map(),
    async list() {
      return candidates.map((candidate) => ({ ...candidate }))
    },
  }
  service.originalList = service.list
  const agent = { session: { header: { cwd } } }
  // 真实 provider 用传入 list 的那个 agent 对象作为 `searches` 的 key，这里必须一致。
  if (options.withSearch !== false) service.searches.set(agent, search)
  const disposers = []
  const ctx = {
    fileReferences: service,
    logger: { info() {}, warn() {} },
    effect(fn) {
      disposers.push(fn())
    },
  }
  return { ctx, service, search, agent, disposers }
}

/** 跑一次查询并取回路径列表。 */
const query = async (service, agent) => (
  await service.list(agent, '', new AbortController().signal)
).map((candidate) => candidate.path)

/** 造一个临时工作区，跑完自动清理。 */
const withWorkspace = async (rules, fn) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ignore-plugin-'))
  try {
    if (rules !== undefined) writeFileSync(join(root, '.dshignore'), rules)
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const FILE = 'file'
const DIR = 'directory'

console.log('文件级规则')

await test('通配符规则过滤文件候选', () => withWorkspace('*.log\n', async (root) => {
  const { ctx, service, agent } = harness(root, [
    { path: 'server.log', kind: FILE },
    { path: 'logs/deep.log', kind: FILE },
    { path: 'server.txt', kind: FILE },
  ])
  apply(ctx, {})
  assert.deepEqual(await query(service, agent), ['server.txt'])
}))

await test('目录规则不影响同名文件（尾斜杠限定）', () => withWorkspace('dist/\n', async (root) => {
  const { ctx, service, agent } = harness(root, [
    { path: 'dist', kind: DIR },
    { path: 'dist', kind: FILE },
    { path: 'a/dist', kind: DIR },
    { path: 'a/dist', kind: FILE },
  ])
  apply(ctx, {})
  assert.deepEqual(await query(service, agent), ['dist', 'a/dist'], '只应保留两个文件候选')
}))

await test('目录规则连同其下所有文件一起隐藏', () => withWorkspace('dist/\n', async (root) => {
  const { ctx, service, agent } = harness(root, [
    { path: 'dist', kind: DIR },
    { path: 'dist/a/b.js', kind: FILE },
    { path: 'keep.js', kind: FILE },
  ])
  apply(ctx, {})
  assert.deepEqual(await query(service, agent), ['keep.js'])
}))

await test('锚定规则只作用于工作区根', () => withWorkspace('/build\n', async (root) => {
  const { ctx, service, agent } = harness(root, [
    { path: 'build', kind: DIR },
    { path: 'packages/a/build', kind: DIR },
    { path: 'packages/a/build/x.js', kind: FILE },
  ])
  apply(ctx, {})
  assert.deepEqual(await query(service, agent), ['packages/a/build', 'packages/a/build/x.js'])
}))

console.log('取反语义')

await test('取反把文件重新包含进来', () => withWorkspace('*.log\n!important.log\n', async (root) => {
  const { ctx, service, agent } = harness(root, [
    { path: 'a.log', kind: FILE },
    { path: 'important.log', kind: FILE },
    { path: 'sub/important.log', kind: FILE },
  ])
  apply(ctx, {})
  assert.deepEqual(await query(service, agent), ['important.log', 'sub/important.log'])
}))

await test('取反可以重新包含目录，其内容随之放行', () => withWorkspace('logs/\n!packages/a/logs/\n', async (root) => {
  const { ctx, service, agent } = harness(root, [
    { path: 'logs', kind: DIR },
    { path: 'logs/x.txt', kind: FILE },
    { path: 'packages/a/logs', kind: DIR },
    { path: 'packages/a/logs/keep.txt', kind: FILE },
  ])
  apply(ctx, {})
  assert.deepEqual(await query(service, agent), ['packages/a/logs', 'packages/a/logs/keep.txt'])
}))

await test('父目录被排除时，取反无法把其中内容捞回来', () => withWorkspace('dist/\n!dist/keep.js\n', async (root) => {
  const { ctx, service, agent } = harness(root, [
    { path: 'dist', kind: DIR },
    { path: 'dist/keep.js', kind: FILE },
  ])
  apply(ctx, {})
  assert.deepEqual(await query(service, agent), [], 'gitignore 语义：父目录被排除则不能重新包含')
}))

console.log('索引剪枝（纯优化路径）')

await test('纯字面目录名并进 excludedDirectories，且只增删自己加过的', () => withWorkspace('ignore-me\n*.log\n', async (root) => {
  const { ctx, service, search, agent } = harness(root, [{ path: 'ignore-me', kind: DIR }])
  apply(ctx, {})
  await query(service, agent)
  assert.deepEqual(
    [...search.excludedDirectories].sort(),
    ['build', 'dist', 'ignore-me', 'node_modules'],
    '只加上 ignore-me；通配规则不剪枝',
  )
  assert.equal(search.invalidations, 1)
}))

await test('可能被取反重新包含的目录名不剪枝', () => withWorkspace('cache/\n!packages/a/cache/\n', async (root) => {
  const { ctx, service, search, agent } = harness(root, [{ path: 'cache', kind: DIR }])
  apply(ctx, {})
  await query(service, agent)
  assert.equal(search.excludedDirectories.has('cache'), false)
  assert.equal(search.invalidations, 0)
}))

await test('pruneIndex: false 时完全不碰内置排除表，但过滤照常', () => withWorkspace('ignore-me\n', async (root) => {
  const { ctx, service, search, agent } = harness(root, [
    { path: 'ignore-me', kind: DIR },
    { path: 'ignore-me/x.txt', kind: FILE },
    { path: 'keep.txt', kind: FILE },
  ])
  apply(ctx, { pruneIndex: false })
  assert.deepEqual(await query(service, agent), ['keep.txt'])
  assert.deepEqual([...search.excludedDirectories].sort(), ['build', 'dist', 'node_modules'])
  assert.equal(search.invalidations, 0)
}))

await test('规则变化后增量更新，已删除的规则名被撤回', () => withWorkspace('ignore-me\n', async (root) => {
  const { ctx, service, search, agent } = harness(root, [{ path: 'ignore-me', kind: DIR }])
  apply(ctx, {})
  await query(service, agent)
  assert.equal(search.excludedDirectories.has('ignore-me'), true)

  writeFileSync(join(root, '.dshignore'), 'other-dir\n')
  await query(service, agent)
  assert.equal(search.excludedDirectories.has('ignore-me'), false, '规则删掉后应撤回')
  assert.equal(search.excludedDirectories.has('other-dir'), true)
  assert.equal(search.excludedDirectories.has('node_modules'), true, '内置默认不能被动到')
  assert.equal(search.invalidations, 2)
}))

await test('插件不会去解除 provider 自己的排除项（已知边界）', () => withWorkspace('!dist/\n', async (root) => {
  const { ctx, service, search, agent } = harness(root, [{ path: 'dist', kind: DIR }])
  apply(ctx, {})
  await query(service, agent)
  assert.equal(search.excludedDirectories.has('dist'), true, 'dist 来自 provider 默认列表，我们只做加法')
}))

console.log('配置与降级')

await test('没有 .dshignore 时行为与内置一致（不改变候选）', () => withWorkspace(undefined, async (root) => {
  const { ctx, service, agent } = harness(root, [
    { path: 'a.log', kind: FILE },
    { path: 'keep.txt', kind: FILE },
  ])
  apply(ctx, {})
  assert.deepEqual(await query(service, agent), ['a.log', 'keep.txt'])
}))

await test('extraPatterns 与文件规则叠加，文件靠后覆盖', () => withWorkspace('!keep.log\n', async (root) => {
  const { ctx, service, agent } = harness(root, [
    { path: 'a.log', kind: FILE },
    { path: 'keep.log', kind: FILE },
  ])
  apply(ctx, { extraPatterns: ['*.log'] })
  assert.deepEqual(await query(service, agent), ['keep.log'])
}))

await test('自定义 ignoreFile 生效', () => withWorkspace(undefined, async (root) => {
  writeFileSync(join(root, 'custom.txt'), 'skipme/\n')
  const { ctx, service, agent } = harness(root, [
    { path: 'skipme', kind: DIR },
    { path: 'keep', kind: DIR },
  ])
  apply(ctx, { ignoreFile: 'custom.txt' })
  assert.deepEqual(await query(service, agent), ['keep'])
}))

await test('search 还没建好（首次查询）也不报错，下次再剪枝', () => withWorkspace('ignore-me\n', async (root) => {
  const { ctx, service, agent } = harness(root, [
    { path: 'ignore-me', kind: DIR },
    { path: 'keep.txt', kind: FILE },
  ], { withSearch: false })
  apply(ctx, {})
  assert.deepEqual(await query(service, agent), ['keep.txt'], '过滤仍然生效')
}))

await test('searches 不是 Map 时退化为纯过滤', () => withWorkspace('ignore-me\n', async (root) => {
  const { ctx, service, agent } = harness(root, [
    { path: 'ignore-me', kind: DIR },
    { path: 'keep.txt', kind: FILE },
  ])
  service.searches = undefined
  apply(ctx, {})
  assert.deepEqual(await query(service, agent), ['keep.txt'])
}))

console.log('生命周期与配置校验')

await test('dispose 后恢复原始 list', () => withWorkspace('ignore-me\n', async (root) => {
  const { ctx, service, agent, disposers } = harness(root, [{ path: 'ignore-me', kind: DIR }])
  apply(ctx, {})
  assert.notEqual(service.list, service.originalList)
  for (const dispose of disposers) dispose()
  assert.equal(service.list, service.originalList)
  assert.deepEqual(await query(service, agent), ['ignore-me'], '还原后不再过滤')
}))

await test('配置非法时抛错（让 Loader 把条目标成失败）', () => {
  const { ctx } = harness('C:/tmp', [])
  assert.throws(() => apply(ctx, { ignoreFile: '' }), /ignoreFile/)
  assert.throws(() => apply(ctx, { extraDirectories: ['a/b'] }), /basename/)
  assert.throws(() => apply(ctx, { extraDirectories: 'tmp' }), /数组/)
  assert.throws(() => apply(ctx, { extraPatterns: [42] }), /非空字符串/)
})

console.log(`\n${passed} 项全部通过`)

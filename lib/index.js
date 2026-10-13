/**
 * dsh-plugin-ignore —— 让 `@` 文件补全按工作区 `.dshignore` 的规则忽略文件与目录。
 *
 * 设计要点：**零运行时 import**。本模块只做两件事：
 *
 * 1. 【正确性】包装 `ctx.fileReferences.list()`，用 `matcher.ignores(path, kind)`
 *    过滤候选。这一层不碰任何内置实现细节，规则语义完全由 `lib/rules.js` 自己保证。
 *
 * 2. 【优化】把"可以安全全局剪枝"的纯目录名并进内置 provider 的
 *    `WorkspaceFileSearch.excludedDirectories`，让它下次重建索引时干脆不遍历这些目录
 *    （省 `maxEntries`、不参与排序、`@目录名/` 直接返回空）。
 *    这一步是纯优化：拿不到 `searches`、或内置结构变了，第 1 步依然保证结果正确。
 *
 * 为什么不抢 `fileReferences` 服务名：同名 Cordis 服务重复注册会冲突，
 * 包装是唯一不需要 disable 内置条目的做法。
 *
 * @module dsh-plugin-ignore
 */
import { createRulesCache } from './rules.js'

/** Cordis 插件名，用于日志与诊断标签。 */
export const name = 'dsh-plugin-ignore'

/** 必须在文件引用服务就绪后才 apply。 */
export const inject = ['fileReferences']

/** 记住被我们包装前的 `list`，让重复 apply / 热更可以幂等还原。 */
const ORIGINAL = Symbol.for('dsh-plugin-ignore.original-list')

/**
 * 校验一个"字符串数组"配置项。
 * @param {unknown} value - 原始值。
 * @param {string} label - 出错时点名的配置项。
 * @returns {string[]} 校验后的副本。
 */
function stringArray(value, label) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`dsh-plugin-ignore: ${label} 必须是字符串数组`)
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') {
      throw new Error(`dsh-plugin-ignore: ${label} 只能是非空字符串`)
    }
  }
  return [...value]
}

/**
 * 校验并补全插件配置。刻意不引入 schemastery：少一个运行时解析依赖，
 * 配置非法时直接抛错，让 Loader 把条目标成失败而不是静默走错分支。
 * @param {unknown} config - Loader 传入的配置。
 * @returns {{ ignoreFile: string, extraPatterns: string[], extraDirectories: string[], pruneIndex: boolean, debug: boolean }}
 */
function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const ignoreFile = raw.ignoreFile ?? '.dshignore'
  if (typeof ignoreFile !== 'string' || ignoreFile === '') {
    throw new Error('dsh-plugin-ignore: ignoreFile 必须是非空字符串')
  }
  const extraDirectories = stringArray(raw.extraDirectories, 'extraDirectories')
  for (const entry of extraDirectories) {
    if (entry.includes('/') || entry.includes('\\')) {
      throw new Error('dsh-plugin-ignore: extraDirectories 只能是非空目录 basename（要写路径请用 extraPatterns）')
    }
  }
  return {
    ignoreFile,
    extraPatterns: stringArray(raw.extraPatterns, 'extraPatterns'),
    extraDirectories,
    pruneIndex: raw.pruneIndex !== false,
    debug: raw.debug === true,
  }
}

/**
 * 一个 agent 的工作区根，与内置 provider 的取法保持一致。
 * @param {{ session?: { header?: { cwd?: string } } }} agent - 目标 agent。
 * @returns {string} 工作区绝对路径。
 */
function cwdOf(agent) {
  return agent?.session?.header?.cwd ?? process.cwd()
}

/** 两个集合内容是否一致。 */
function sameNames(left, right) {
  if (left.size !== right.size) return false
  for (const value of left) if (!right.has(value)) return false
  return true
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx - host 上下文。
 * @param {unknown} config - 插件配置。
 */
export function apply(ctx, config) {
  const service = ctx.fileReferences
  if (service === undefined || service === null) return
  const options = normalizeConfig(config)
  const rules = createRulesCache(options)
  /** 每个 search 实例当前生效的剪枝名单，用于增量增删与失效判断。 */
  const applied = new WeakMap()
  /** 已经打过日志的规则文件版本，避免每次查询都刷屏。 */
  const reported = new Map()

  // 存未绑定的原方法，dispose 时能精确还原成同一个引用。
  const original = service[ORIGINAL] ?? service.list
  service[ORIGINAL] = original

  /**
   * 把可安全剪枝的目录名同步到内置 provider 的 search 实例（纯优化步骤）。
   * @param {object} agent - 目标 agent。
   * @param {Set<string>} names - 本次生效的剪枝名单。
   */
  const pruneIndex = (agent, names) => {
    if (!options.pruneIndex) return
    const searches = service.searches
    if (!(searches instanceof Map)) return
    const search = searches.get(agent)
    // 首次查询时 search 还没被创建（provider 在它自己的 list 里懒建），下次再同步即可：
    // 本次结果的正确性由候选过滤保证。
    if (search === undefined || !(search.excludedDirectories instanceof Set)) return
    const previous = applied.get(search)
    if (previous === undefined) {
      applied.set(search, new Set(names))
      // 没有可剪的名字就别白调一次 invalidate()。
      if (names.size === 0) return
      for (const added of names) search.excludedDirectories.add(added)
      search.invalidate?.()
      return
    }
    if (sameNames(previous, names)) return
    // 只增删我们自己加过的名字，内置默认列表与 profile patch 一概不动。
    for (const gone of previous) if (!names.has(gone)) search.excludedDirectories.delete(gone)
    for (const added of names) search.excludedDirectories.add(added)
    search.invalidate?.()
    applied.set(search, new Set(names))
  }

  service.list = async (agent, query, signal) => {
    // 先放行：provider 会在这一步懒建该 agent 的 search，我们随后才能改它。
    const candidates = await original.call(service, agent, query, signal)

    let matcher
    try {
      const entry = rules.lookup(cwdOf(agent))
      matcher = entry.matcher
      if (options.debug && reported.get(entry.file) !== entry.stamp) {
        reported.set(entry.file, entry.stamp)
        ctx.logger?.info?.(
          `dsh-plugin-ignore: ${entry.file} → ${matcher.rules.length} 条规则`
          + `${matcher.skipped.length === 0 ? '' : `，跳过 ${matcher.skipped.length} 行：${matcher.skipped.join(' | ')}`}`,
        )
      }
    } catch (error) {
      // 规则读不出来才退回内置行为；这属于异常路径，记一条日志。
      ctx.logger?.warn?.(
        `dsh-plugin-ignore: 规则读取失败，本次按未过滤处理：${error instanceof Error ? error.message : String(error)}`,
      )
      return candidates
    }

    // 剪枝只是优化，单独兜住：它失败也必须继续过滤。
    try {
      pruneIndex(agent, matcher.promotableDirectories())
    } catch (error) {
      ctx.logger?.warn?.(
        `dsh-plugin-ignore: 索引剪枝失败（过滤照常）：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    if (matcher.isEmpty) return candidates
    return candidates.filter((candidate) => !matcher.ignores(candidate.path, candidate.kind))
  }

  ctx.effect(() => () => {
    if (service.list !== original) service.list = original
    rules.clear()
    reported.clear()
  }, 'dsh-plugin-ignore: list wrapper')
}

/**
 * `.dshignore` 的规则语言：解析、编译、匹配、缓存。
 *
 * ## 支持的语法（gitignore 语义的子集，逐条实现）
 *
 * | 写法 | 含义 |
 * |---|---|
 * | `# 注释` | 整行注释；`\#` 表示以 `#` 开头的字面名字 |
 * | 空行 | 忽略 |
 * | `name` | 任意深度下名为 `name` 的文件或目录 |
 * | `name/` | 只匹配目录（尾 `/`） |
 * | `/name` | 锚定到工作区根：只匹配根下的 `name` |
 * | `a/b` | 含 `/` 即锚定到工作区根 |
 * | `*` | 匹配一段内的任意字符（不含 `/`） |
 * | `?` | 匹配一段内的单个字符 |
 * | `[a-z]` / `[!a-z]` | 字符类，不跨 `/` |
 * | `**` 打头 / 结尾 / 夹在两段之间 | 跨目录匹配（兼容任意层目录、其下全部内容、中间夹层） |
 * | `!pattern` | 取反：重新包含 |
 *
 * ## 语义要点
 *
 * - **最后匹配的规则生效**（同 gitignore）；
 * - **父目录被排除时无法重新包含其中内容**（git 的硬性规定）。所以判定一个路径时，
 *   先逐级检查它的祖先目录，任一祖先被排除即视为被排除；
 * - 大小写敏感（与内置 provider 的 `excludedDirectories` 一致）；
 * - 路径基准是工作区根，`/` 分隔；Windows 的反斜杠会先归一化。
 *
 * ## 两个独立能力
 *
 * - `matcher.ignores(path, kind)` —— **正确性**，候选过滤用；
 * - `matcher.promotableDirectories()` —— **优化**，返回可以安全交给内置
 *   `excludedDirectories` 做遍历剪枝的纯目录名（保守子集，见该方法的注释）。
 *
 * 该模块不依赖任何 DSH 运行时包，可以用纯 node 跑单测。
 *
 * @module dsh-plugin-ignore/rules
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 默认规则文件名，位于每个 agent 的工作区根。 */
export const DEFAULT_IGNORE_FILE = '.dshignore'

/** 正则元字符转义。 */
const REGEXP_META = /[.*+?^${}()|[\]\\]/gu
const escapeRegExp = (character) => character.replace(REGEXP_META, '\\$&')

/** 把 `/` 与 `\` 归一化成 `/`，并去掉多余的 `./` 前缀与首尾斜杠。 */
export function normalizePath(path) {
  return String(path)
    .replaceAll('\\', '/')
    .replace(/^(?:\.\/)+/u, '')
    .replace(/\/+/gu, '/')
    .replace(/^\/|\/$/gu, '')
}

/**
 * 把一段 glob 编译成正则源码。
 * @param {string} pattern - 已去掉 `!`、尾 `/` 与锚定前缀的 glob。
 * @returns {string} 不含 `^`/`$` 锚点的正则源码。
 */
function globToRegExpSource(pattern) {
  let out = ''
  let index = 0
  while (index < pattern.length) {
    const character = pattern[index]

    if (character === '\\' && index + 1 < pattern.length) {
      out += escapeRegExp(pattern[index + 1])
      index += 2
      continue
    }

    if (character === '*') {
      const isDouble = pattern.startsWith('**', index)
      const atSegmentStart = index === 0 || pattern[index - 1] === '/'
      const after = pattern[index + (isDouble ? 2 : 1)]
      // 只有 `**/`、结尾的 `/**`、`a/**/b` 三种形态才有跨目录含义，
      // 其余连续星号按普通 `*` 处理（与 gitignore 文档一致）。
      if (isDouble && atSegmentStart && after === '/') {
        out += '(?:.*/)?'
        index += 3
        continue
      }
      if (isDouble && atSegmentStart && after === undefined) {
        out += '.*'
        index += 2
        continue
      }
      out += '[^/]*'
      index += isDouble ? 2 : 1
      continue
    }

    if (character === '?') {
      out += '[^/]'
      index += 1
      continue
    }

    if (character === '[') {
      let cursor = index + 1
      let negated = false
      if (pattern[cursor] === '!' || pattern[cursor] === '^') {
        negated = true
        cursor += 1
      }
      let body = ''
      if (pattern[cursor] === ']') {
        body += '\\]'
        cursor += 1
      }
      let closed = false
      while (cursor < pattern.length) {
        const inner = pattern[cursor]
        if (inner === '\\' && cursor + 1 < pattern.length) {
          body += `\\${pattern[cursor + 1]}`
          cursor += 2
          continue
        }
        if (inner === ']') {
          closed = true
          break
        }
        // 字符类永远不匹配路径分隔符；`[` 与 `^` 需要转义才安全。
        if (inner === '/') {
          cursor += 1
          continue
        }
        if (inner === '^') {
          body += '\\^'
          cursor += 1
          continue
        }
        body += inner === '[' ? '\\[' : inner
        cursor += 1
      }
      if (!closed) {
        out += '\\['
        index += 1
        continue
      }
      out += negated ? `[^${body}/]` : `[${body}]`
      index = cursor + 1
      continue
    }

    out += escapeRegExp(character)
    index += 1
  }
  return out
}

/** 取一个 glob 最后一段（用于判断取反规则能否重新包含某个目录名）。 */
function lastSegment(pattern) {
  const slash = pattern.lastIndexOf('/')
  return slash < 0 ? pattern : pattern.slice(slash + 1)
}

/**
 * 编译一行规则。
 * @param {string} raw - 规则文件的原始行。
 * @returns {{ negated: boolean, dirOnly: boolean, anchored: boolean, glob: string, literal: boolean, regex: RegExp } | undefined}
 *   无法使用的行返回 `undefined`。
 */
function compileLine(raw) {
  let text = raw.trim()
  if (text === '') return undefined
  if (text.startsWith('\\#')) text = text.slice(1)
  else if (text.startsWith('#')) return undefined

  let negated = false
  if (text.startsWith('\\!')) text = text.slice(1)
  else if (text.startsWith('!')) {
    negated = true
    text = text.slice(1)
  }

  let dirOnly = false
  if (/\/+$/u.test(text)) {
    dirOnly = true
    text = text.replace(/\/+$/u, '')
  }
  if (text === '') return undefined

  // 含 `/`（尾斜杠已去掉）即视为锚定到工作区根，前导 `/` 只是显式写法。
  const anchored = text.includes('/')
  if (text.startsWith('/')) text = text.replace(/^\/+/u, '')
  if (text === '') return undefined

  const source = globToRegExpSource(text)
  const prefix = anchored ? '^' : '^(?:.*/)?'
  return {
    negated,
    dirOnly,
    anchored,
    glob: text,
    literal: !/[*?[\]\\]/u.test(text),
    regex: new RegExp(`${prefix}${source}$`, 'u'),
  }
}

/**
 * 编译一组规则行。
 * @param {readonly string[]} lines - 规则行（顺序即优先级，靠后覆盖靠前）。
 * @returns {{ rules: object[], skipped: string[] }} 编译结果与被跳过的行。
 */
export function compileRules(lines) {
  const rules = []
  const skipped = []
  for (const line of lines) {
    const rule = compileLine(line)
    if (rule === undefined) {
      if (line.trim() !== '' && !line.trim().startsWith('#')) skipped.push(line)
      continue
    }
    rules.push(rule)
  }
  return { rules, skipped }
}

/**
 * 生成一个匹配器。
 * @param {readonly string[]} lines - 规则行。
 * @returns {{
 *   rules: object[],
 *   skipped: string[],
 *   isEmpty: boolean,
 *   ignores: (path: string, kind?: 'file' | 'directory') => boolean,
 *   matchesExactly: (path: string, kind?: 'file' | 'directory') => boolean,
 *   promotableDirectories: () => Set<string>,
 * }}
 */
export function createMatcher(lines) {
  const { rules, skipped } = compileRules(lines)

  // 取反规则的"最后一段"：只有它能决定某个同名目录是否可能被重新包含。
  const reincludeSegments = rules
    .filter((rule) => rule.negated)
    .map((rule) => {
      const segment = lastSegment(rule.glob)
      return new RegExp(`^${globToRegExpSource(segment)}$`, 'u')
    })

  /** 单条路径的判定，不含祖先规则。 */
  const matchesExactly = (path, kind) => {
    const normalized = normalizePath(path)
    if (normalized === '') return false
    let ignored = false
    for (const rule of rules) {
      if (rule.dirOnly && kind !== 'directory') continue
      if (rule.regex.test(normalized)) ignored = !rule.negated
    }
    return ignored
  }

  return {
    rules,
    skipped,
    isEmpty: rules.length === 0,
    matchesExactly,

    /**
     * 完整语义判定：先逐级检查祖先目录，任一祖先被排除就直接排除
     * （gitignore：父目录被排除时无法重新包含其中内容）。
     * @param {string} path - 候选路径（相对工作区根）。
     * @param {'file' | 'directory'} [kind] - 候选类型。
     * @returns {boolean} 是否应隐藏。
     */
    ignores(path, kind) {
      if (rules.length === 0) return false
      const normalized = normalizePath(path)
      if (normalized === '') return false
      const segments = normalized.split('/')
      for (let index = 0; index < segments.length - 1; index += 1) {
        if (matchesExactly(segments.slice(0, index + 1).join('/'), 'directory')) return true
      }
      return matchesExactly(normalized, kind)
    },

    /**
     * 可以安全交给内置 `excludedDirectories` 做**遍历剪枝**的纯目录名。
     *
     * 保守子集，只收同时满足以下条件的规则：
     * - 未取反；
     * - 未锚定（锚定规则只作用于根下某个具体路径，不能全局按名字剪枝）；
     * - 不含通配符的纯字面名字（`dist`、`dist/`），因为剪枝只能按 basename 精确匹配；
     * - 没有任何取反规则的最后一段能匹配这个名字——否则那条取反可能重新包含
     *   同名目录，剪掉就再也回不来了。
     *
     * 取不到名字（宁可少剪枝）不影响正确性：过滤由 `ignores` 独立保证。
     * @returns {Set<string>} 可剪枝的目录名。
     */
    promotableDirectories() {
      const names = new Set()
      for (const rule of rules) {
        if (rule.negated || rule.anchored || !rule.literal) continue
        if (reincludeSegments.some((segment) => segment.test(rule.glob))) continue
        names.add(rule.glob)
      }
      return names
    },
  }
}

/**
 * 建立一个按工作区根缓存的规则查询器。
 *
 * 失效策略：每次查询只对规则文件做一次浅 `stat`，`mtimeMs` 或 `size` 变了才重新读取与编译。
 * 文件不存在即视为空规则（不报错）。
 *
 * @param {{ ignoreFile?: string, extraPatterns?: readonly string[], extraDirectories?: readonly string[] }} [options] - 插件配置。
 * @returns {{ lookup: (cwd: string) => { file: string, stamp: string, matcher: ReturnType<typeof createMatcher> }, clear: () => void }}
 */
export function createRulesCache(options = {}) {
  const ignoreFile = typeof options.ignoreFile === 'string' && options.ignoreFile !== ''
    ? options.ignoreFile
    : DEFAULT_IGNORE_FILE

  // 配置里的额外规则排在文件前面：文件里的规则更贴近工作区，靠后覆盖。
  const extraLines = [
    ...(options.extraPatterns ?? []),
    // 兼容旧配置：目录名等价于一条"只匹配目录"的规则。
    ...(options.extraDirectories ?? []).map((name) => `${name}/`),
  ]

  /** @type {Map<string, { file: string, stamp: string, matcher: ReturnType<typeof createMatcher> }>} */
  const cache = new Map()

  return {
    lookup(cwd) {
      const root = cwd === undefined || cwd === null || cwd === '' ? process.cwd() : String(cwd)
      const file = join(root, ignoreFile)
      let stamp = 'absent'
      let fileLines = []
      try {
        const stats = statSync(file)
        if (stats.isFile()) {
          stamp = `${stats.mtimeMs}:${stats.size}`
          fileLines = readFileSync(file, 'utf8').split(/\r?\n/u)
        }
      } catch {
        // 文件不存在或不可读：按空规则处理，不抛错。
      }
      const cached = cache.get(root)
      if (cached !== undefined && cached.stamp === stamp) return cached

      const entry = { file, stamp, matcher: createMatcher([...extraLines, ...fileLines]) }
      cache.set(root, entry)
      return entry
    },
    clear() {
      cache.clear()
    },
  }
}

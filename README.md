# dsh-plugin-ignore

让 DSH 的 `@` 文件补全按工作区根的 `.dshignore` 忽略文件与目录。

在输入框打 `@` 时，命中规则的目录/文件不会出现在候选里，也无法通过 `@目录名/` 钻进去看内容。

## 只影响候选列表，不限制访问

这个插件的唯一目的是**让 `@` 的可选项少一点**，它不注册工具、不拦截读写，所以：

- 手动打 `@dist/app.js` 照样进入对话，模型也能正常 `read`/`grep` 这些路径；
- 被忽略的目录不再被遍历索引，但这只影响"列出什么候选"，与文件读取无关。

想"让模型读不到"要用另一层机制（工具 guard），本插件刻意不做。

## 规则文件

工作区根放一个 `.dshignore`（文件名可配）：

```gitignore
# 注释以 # 开头，空行忽略；\# 和 \! 表示以这些字符开头的字面名字

node_modules          # 任意深度下名为 node_modules 的文件或目录
dist/                 # 尾斜杠：只匹配目录
/docs                 # 前导斜杠：锚定到工作区根，只忽略根下的 docs
*.log                 # 通配符不跨目录，任意深度的 .log 都命中
build/**              # 跨目录：build 下的所有内容（build 目录本身不算）
a/**/b                # 跨目录：a 与 b 之间隔任意层
secrets.env
!important.log        # 取反：重新包含
```

### 语义

- **最后匹配的规则生效**（同 gitignore）：`*.log` 之后再写 `!important.log`，后者胜出。
- **父目录被排除时无法重新包含其中内容**（git 的硬性规定）：
  写了 `dist/`，那么 `!dist/keep.js` 是无效的——`dist/` 整棵子树都不可见。
  想让内容可见，取反要作用在目录本身：`!packages/a/dist/`。
- **大小写敏感**，与内置 provider 的 `excludedDirectories` 一致。
- 路径基准是工作区根，`/` 分隔；Windows 的反斜杠会先归一化。
- 只读工作区根那一份 `.dshignore`，不递归读取子目录里的。

## 配置

```yaml
- id: dsh-plugin-ignore
  name: 'dsh-plugin-ignore'
  config:
    ignoreFile: .dshignore     # 相对工作区根
    extraPatterns: []          # 额外规则，语法同上；排在文件规则之前，所以文件里的规则覆盖它
    extraDirectories: []       # 旧写法：一串纯目录名，等价于 extraPatterns 里的 `名字/`
    pruneIndex: true           # 是否把可安全全局剪枝的目录名交给内置索引，纯性能开关，关掉只影响速度
    debug: false               # 把生效规则条数 / 无法解析的行打到日志
```

## 安装与卸载

它已经是一个 **bundle**（`package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`）。
用 CLI 装进 `desktop` profile：

```bash
dsh plugin --profile desktop add D:\ai-project\dsh-plugin-ignore
```

- `dsh plugin --profile <name> <args>` 就是把 `<args>` 转给 profile 目录里的 pnpm，
  所以 `add` / `remove` / `install` 都是 pnpm 语义；相对路径按**执行命令时所在的目录**解析。
- 本地目录只有绝对路径才稳妥（Web 插件页也只接受绝对路径），`link:` 写法同样以路径为准。
- `desktop` 是桌面客户端自己的 profile，比别的 profile 多两道限制：先**启动一次桌面版 DSH**
  （由它初始化 `$DSH_HOME/profiles/desktop/`），再**完全退出客户端**，然后才能跑上面的命令。
  客户端还在运行时它锁着 profile 的 `package.json`；而 profile 尚未初始化时，
  CLI 会直接报错让你先去打开一次桌面版。
- 装完 pnpm 会把本地目录记录成 `link:` 依赖写进 profile 的 `package.json`，
  并把 `dsh-plugin-ignore` 追加进 `dsh.profile.bundles`；因为是 link，改代码不用重新安装。
- 新装的 bundle 默认选中。`desktop` 与 `web` 一样是实时重载的组合，装完通常无需重启；
  替换**已装包**的代码要重启 DSH，才能加载新的 JS 模块（只重载条目不够）。
- `name` 换成其他 profile（`web`、`headless`、`sdk`、自定义名）就装到那边。

卸载：

```bash
dsh plugin --profile desktop remove dsh-plugin-ignore
```

或者用插件管理（Web 插件页 / `plugin_manager`：`install_bundle target = D:\ai-project\dsh-plugin-ignore`、
`remove_bundle target = dsh-plugin-ignore`），两条路做的是同一件事。
注意**没有启用 HMR 的 profile** 不能卸载正在被它自己使用的包，要先停掉进程再卸。

## 已知限制

- **内置默认排除不会被取反解除。** provider 自己默认排除
  `.git`、`node_modules`、`dist`、`build`、`out`、`coverage`、`target`、`.next`、`.nuxt`、
  `.turbo`、`.venv`、`__pycache__`、`.pytest_cache`、`.mypy_cache`、`.gradle`
  这 15 个目录名，本插件**只做加法、从不删减**，所以 `.dshignore` 里写 `!dist/` 不会让 `dist` 回来。
  要放开请改 provider 的配置（profile 的 `cordis.patch.yml` 里给 `file-reference-local`
  重写 `excludedDirectories`）——注意那也会让索引重新遍历这些目录。
- 只按工作区根一份规则文件生效，不支持子目录各自的 `.dshignore`。
- 规则变化后递归索引在后台重建，重建完成前由候选过滤兜底（用户看不到差别）。

## 常见问题：`@` 候选整个空了

先刷新页面（F5），再考虑重启 DSH：profile 反复重新组合（装插件、改 patch、切条目）
之后，Web 客户端的模块图可能是陈旧的。

可以确定**不是本插件的过滤**造成的：它只做减法——候选非空时，只有全部命中规则才会变空。
按这个顺序查：

1. 打开 `debug: true`，确认 `.dshignore` 被读到、看生效规则条数；
2. 逐条注释掉 `.dshignore` 里的规则，打 `@` 看候选是否恢复；
3. 只有"provider 本身返回空"（工作目录不对、目录不存在）才会一上来就没有候选。

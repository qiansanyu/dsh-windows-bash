# Changelog

本项目的所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-05

本版是维护分支的首个版本（fork 自 [LAN-TINA-WS/dsh-windows-shell-policy](https://github.com/LAN-TINA-WS/dsh-windows-shell-policy) 0.0.7，原作者已停止跟进）。归属与改动范围见 [NOTICE](NOTICE)。

### 修复（阻塞级）

- **dsh 0.2.2 上每次发消息都崩**：`system-prompt/assemble` 的载荷自 `0.2.2-alpha.2` 起从 `PromptAssembly` 改为 `PromptPresentation`（去掉 `tools`，工具声明归 provider，瀑布之后才拼回）。旧实现在瀑布里 `assembled.tools.filter(...)` 恒为 `undefined.filter`，抛出的 TypeError 被 agent-loop 收敛成 `turn/end.reason.error{code:'UNKNOWN'}`，表现为"本轮运行失败 Cannot read properties of undefined (reading 'filter')"，且该 turn 不产生任何模型请求。**不是**加可选链能解决的：那会让模型同时拿到 `pwsh` + `bash`

### 变更

- **工具面收敛改为 per-agent `tools.restrict({ deny })`**（官方在 0.2.2 里隐藏另一个全局工具的唯一途径）：判定抽到 `src/policy.ts` 的纯函数 `desiredHide`；同步点在 `agent/created`（serial，首轮之前）、`agent/status→running`、`agent/inbox/inserted`（每次提交前，同轮生效）、`agent/disposed`（撤销）；`applyPolicy()` 末尾对活着的 agent 重扫一遍，避免"bash 注销了、pwsh 还被 deny"导致一个 shell 都不剩
  - 行为比旧版更彻底：旧版只删请求里的 schema，执行准入集合里那个 shell 还在；`restrict` 两者同时收窄（模型硬调被隐藏的 shell 会被判 unknown）
- **运行时依赖从 `devDependencies` 移到 `dependencies`**（`@deepseek-ai/dsh-llm` / `dsh-sandbox` / `dsh-tools` / `schemastery`），版本写成 `>=0.2.2-rc.1 <0.3.0-0`：0.0.7 把运行期 import 钉在 `devDependencies@0.2.0-rc.2`，`link:` 加载时 Node 从插件自己的 `node_modules` 解析 → **类型按 0.2.0 编译、运行时按 0.2.2 崩**，这是本次事故的第二个根因
- `schemastery` fork alias 从 `3.18.4` 升到 `~3.19.0`（与 dsh 0.2.2-rc.1 及 `dsh-tools` 的依赖同一条线；跨版本会装出两份并触发 TS2742）
- `package.json` 增加 `engines.dsh`（`>=0.2.2-rc.1 <0.3.0-0`）

### 工程

- 抽出 `src/policy.ts`（`bashViableInMode` / `desiredHide` 纯函数）+ `test/policy.test.mjs`（5 个用例，`npm test`）
- 增加 `npm run build:tsc`：`tsc -p tsconfig.json` 直接出 `lib/`，不再依赖 `scripts/build.sh` 的 `DSH_CHECKOUT`（本机没有 dsh 源码 checkout 时也能构建）

### 文档

- README（中/英）、`docs/capabilities-host.md`、`docs/conventions.md`、`docs/roadmap-composition.md` 同步新机制与新的依赖口径；新增 [NOTICE](NOTICE) 记录 fork 出处与改动范围

## [Unreleased]

### 修复

- **安全：状态/配置 API 增加请求准入**：`/dsh-shell-policy/api/*` 是裸 webServer 前缀路由，不在 `client-connection` 的 token/cookie 鉴权伞下；handler 入口新增 `isLocalGuiRequest`——带 `Origin` 头时（浏览器跨站 fetch 与表单 POST 均会带）要求回环主机，不带时（同源 GET/本地脚本）要求 `Host` 为回环。挡掉跨站页面经 simple request 静默改写 `preferred`/`bashPath`（`bashPath` 可被改写为任意可执行路径，是其中影响最大的一项）以及 Host 指向外部域名的 DNS rebinding 类请求
- **提示词一致性**：`effective=pwsh`（含 bash 工具注册失败回落 pwsh）时不再注入"bash 是默认 shell"引导文本；section `text` 改为每次 assemble 求值的函数，由框架过滤空文本，与模型实际看到的工具面保持一致
- **健壮性**：bash 子进程环境补充 `NO_COLOR=1` / `TERM=dumb` / `PAGER=cat` / `GIT_PAGER=cat`（对齐官方 `dsh-bash-local` 的 `ENV_OVERRIDES`），避免分页器把命令挂起到超时、以及 ANSI 转义序列污染工具输出

## [0.0.7] - 2026-10-01

### 变更

- **适配 DSH 0.2.0 配置架构**：
  - Config 字段标记 `.volatile()`（0.2.0 的 live 配置要求；未标记则设置页不显示、写入报错）
  - 读取经 volatile 解包（结构检测，零依赖）
  - client 配置页注册迁移到 `plugins.bundle.config`（0.2.0 的 bundle 配置槽位，渲染在插件管理页的插件详情页内）
  - 保留 0.1.x 的 `settings.plugin.item` 注册（旧版兼容，0.2.0 下无副作用）

## [0.0.5] - 2026-08-21

### 修复

- **卡片边框黑色问题**：React inline style 下 `border` 简写 + CSS 变量拆解会丢失（border-color 回落 currentColor 黑色），全部改为长写属性（borderWidth/borderStyle/borderColor、borderTop*），折叠/展开边框颜色与官方卡片一致（品牌蓝 / label-dimmed）

## [0.0.4] - 2026-08-21

### 修复

- **展开键图标对齐官方**：卡片头部 chevron 由 `▾` 字符替换为官方 `IconChevronDownOutline14` 等价 SVG（14x14，fill=currentColor），与「终端 / Agent 循环 / 网页搜索」卡片视觉一致；展开旋转 180deg 动画保留

## [0.0.3] - 2026-08-21

### 新增

- **run_in_background 后台执行**：bash 工具支持 `run_in_background: true`（jobs 通道，`job_output`/`job_kill` 收集与停止），与官方 shell 工具对齐
- **文件沙箱集成**：standing policy 解析（sandboxPolicy）+ `sandbox.confine` 包装 + `sandbox_permissions`/`justification` 升级（approveEscalation）+ denial 检测与标记，与官方 shell 工具对齐
- **bashPath 面板配置**：卡片新增「bash 可执行文件路径」输入框（留空自动探测），host API `/bashpath` 持久化
- **卡片实时刷新**：监听 `settings/document-updated` 事件，外部写入（settings.yaml 等）后卡片状态自动刷新
- **注册失败状态显示**：bash 工具注册失败时卡片显示具体错误（status API `registerError` 字段）

### 修复

- **非 Windows 平台跳过**：Linux/macOS 上不再注册工具、不再裁剪提示词（此前会误过滤官方 bash 工具导致 agent 无 shell 工具）；卡片显示「仅 Windows 支持」
- **workdir 语义**：相对 workdir 按 session cwd 解析，缺省用 session cwd（此前按 process.cwd()）
- **types 声明**：exports `"./client"` 移除指向不存在文件的 types 行

## [0.0.2] - 2026-08-21

### 修复

- **[rc.7 兼容]** `settings.plugin.item` slot 注册补 `key` 字段：DSH 0.1.0-rc.7 起该 slot 由 `kind:'list'` 改为 `kind:'keyed'`，注册缺 key 会抛 `keyed slot "settings.plugin.item" requires options.key` 导致设置面板加载失败（与 dsh-gui-customization issue #3 同类问题）。list 下多余 key 字段被忽略，向后兼容旧版本。

## [0.0.1] - 2026-08-21

### 新增

- bash 探测：显式 `bashPath` → Git 常见安装路径（Program Files / x86）→ MSYS2 / Cygwin → PATH
- 「默认 Shell」折叠配置卡片（`settings.plugin.item` slot，与官方卡片同构）：自动 / bash / pwsh 三选一，staged 编辑 + 保存/放弃，折叠时保留未保存标记
- 策略生效：`auto` 时探测到 bash 则用 bash 否则 pwsh；显式 bash/pwsh 强制对应 shell；切换下一次请求生效
- bash 工具动态注册（`ctx.tools.register` disposer 切换）：git-bash 执行（subprocess 通道），超时 / 输出截断 / exit code 标记
- 终端卡片展示（`presentCall`/`presentResult`）：对话页可点击查看命令、cwd、输出与 exit 状态，与官方 shell 工具一致
- 提示词裁剪（`system-prompt/assemble`）：按策略隐藏 pwsh / bash，agent 工具面只保留一个 shell 工具
- 引导文本（`systemPrompt.section`）：声明 bash 为默认 shell
- 持久化：`preferred` 写入 settings 文档 `shell-policy` section，重启保留
- webServer API：`/dsh-shell-policy/api/status` 与 `/preferred`（卡片读写通道，绕开 apiproxy settings allowlist）
- bundle patch 装配（`cordis.patch.yml` + `dsh.bundle.patch`）：支持 `dsh plugin add` 正式安装

### 修复

- 无（首版）

### 已知限制

- 工具 schema 按请求刷新：切换后下一次请求生效，当前请求的工具面不变
- 系统提示文本按会话快照：已开始会话的提示词里可能残留旧 shell 工具定义（新会话干净）
- 仅 Windows 语义：Linux/macOS 上不生效（规划 P3）

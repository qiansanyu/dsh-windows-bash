# Changelog

本项目的所有重要变更记录于此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-11-21

本版是独立仓库的首个版本：脱离 fork 网络，以新名 `dsh-windows-bash` 发布（GitHub 仓库与 npm 包同名）。出处与归属见 [NOTICE](NOTICE)。

### 变更

- **包与插件标识更名**：npm/GitHub 包名、cordis 插件名（`export const name`）、profile entry 解析（`PKG_NAME`）、client bundle 配置页 key（`plugins.bundle.config` 的 key = 包名，不同步会导致配置页不渲染）、client bundle loader id（`tsdown.config.ts` 的 `PLUGIN_ID`）、bundle patch 装配 id、状态/配置 API 路由前缀（`/dsh-shell-policy/api` → `/dsh-windows-bash/api`）同步更名为 `dsh-windows-bash`；`[shell-policy]` 日志前缀、systemPrompt section 名等域语义标识保持不变
- **迁移注意**：新旧是两个不同的 profile entry——旧版 `dsh-windows-shell-policy` 需 `dsh plugin remove` 手动卸载，其中已保存的 `preferred`/`bashPath` 不自动迁移（重装后回到默认 `auto`，探测到 bash 即生效，通常无感）；安装命令改为 `dsh plugin --profile web add github:qiansanyu/dsh-windows-bash`
- **文档清洗**：能力清单对齐 0.2.2 事实（settings 持久化走 `settings.mutate(entryId)`、配置页主入口 `plugins.bundle.config`）；「设计决策（why）」并入 conventions.md，退役 roadmap 施工流水账；验收判据补充 spill 路径的覆盖说明；README 修正 bashPath「面板编辑在规划中」的过时说法（面板编辑已可用）

## [0.1.1] - 2026-11-21

本版面向 dsh `0.2.2-rc.5` 宿主：补齐与官方 `tool-bash` 的对齐面（超时晋升、截断回传、结果标记、参数面），并依据本机 106 个 dsh session（7,517 条 bash 命令）的证据分析，把 Windows 专项防呆写进工具描述。

### 修复

- **后台作业输出恒为空（`job_output` 只回空、完成通知永远「No new output」）**：`jobs.start` 用的是旧版 `run().readOutput` 钩子，而当前 `@deepseek-ai/dsh-jobs` 只在 `spec.output` 非空时启动 pump，`readOutput` 已不被读取 ⇒ 后台进程的 stdout/stderr 从未进 ring。改为在 `spec` 里提供惰性绑定的 stdout/stderr `JobOutputSource`（spawn 发生在 `run()` 里，注册表首次 drain 早于它，源按 `running` 惰性取值）。顺带把非零退出的 `JobOutcome` 从 `failed` 改为 `completed` + `detail: exit code: N`：`failed` 在 jobs 契约里指作业基础设施失败，非零退出是命令的正常结果，与官方 `tool-bash` 同口径
- **安全：状态/配置 API 增加请求准入**：`/dsh-shell-policy/api/*` 是裸 webServer 前缀路由，不在 `client-connection` 的 token/cookie 鉴权伞下；handler 入口新增 `isLocalGuiRequest`——带 `Origin` 头时（浏览器跨站 fetch 与表单 POST 均会带）要求回环主机，不带时（同源 GET/本地脚本）要求 `Host` 为回环。挡掉跨站页面经 simple request 静默改写 `preferred`/`bashPath`（`bashPath` 可被改写为任意可执行路径，是其中影响最大的一项）以及 Host 指向外部域名的 DNS rebinding 类请求
- **提示词一致性**：`effective=pwsh`（含 bash 工具注册失败回落 pwsh）时不再注入"bash 是默认 shell"引导文本；section `text` 改为每次 assemble 求值的函数，由框架过滤空文本，与模型实际看到的工具面保持一致
- **健壮性**：bash 子进程环境补充 `NO_COLOR=1` / `TERM=dumb` / `PAGER=cat` / `GIT_PAGER=cat`（对齐官方 `dsh-bash-local` 的 `ENV_OVERRIDES`），避免分页器把命令挂起到超时、以及 ANSI 转义序列污染工具输出
- **confined 会话自动回落 pwsh**：MSYS 运行时启动需要命名信号管道，Windows ACL 沙箱（read-only/workspace-write）拒绝其创建（Win32 error 5），git-bash 在受限模式下起不来。改为可用性判定（`bashViableInMode`）+ execute 拦缺（可读错误而非 fatal）+ status API 报 `bashStartableInDefaultMode`；confined 会话隐藏 bash、回落官方 pwsh，保证模型手里始终是真能跑的 shell
- **卡片保存实时生效**：`preferred`/`bashPath` 是 volatile 热配置，Loader 只做引用就地提交并发 `loader/volatile-update` 事件、不重建 entry——须监听该事件重算探测与工具注册，否则卡片保存后 `probe`/`effective` 停留在 apply 时刻的旧值
- 顺修 `loader/volatile-update` 监听重复注册（幂等无害，属笔误）

### 新增

- **超时晋升后台（promote-on-timeout）**：前台命令超时不再被杀——先把命令注册成 job（`onExpiry:"none"`），`registry.wait(id, timeoutMs)` 到点仍在跑则晋升：模型立刻拿到已产出的部分输出 + `[still running after <N>ms; moved to background job <id>]`，此后 `job_output` 从晋升点续读（`registry.read` 推进消费游标，不重不漏；落后于 ring 时按官方口径补 dropped-output 通知）。`promoteOnTimeout` 可配置（默认开，设置面板可改且热切换触发重注册）；注册被拒 / 无 jobs 服务退回「前台 + 到期杀」。与官方 `dsh-tool-bash` `waitOnJob` 语义逐项对齐（取消时杀 job 等落地不另行通知、定时内落定摘除记录、两处 seam 差异有注释说明）
- **截断输出回传 spill 全量路径**：stdout/stderr 各自在截断时追加 `[output truncated; full output: <path>]`（与官方 `streamText` 逐字符一致，路径缺失时 `(unavailable)` 占位），输出 schema 的 stdout/stderr 增加 `spillPath` 字段——模型直接读文件取全量，不再花一轮调用用 `sed`/`head` 重跑分段截取

### 变更

- **bash 工具 description 重写**：收录官方防呆四句（删除/移动前验证解析后的绝对路径、`${VAR:?}` 防未定义变量空展开、沙箱拒绝属策略不要换法重试、长输出落盘预告）+ Windows notes（MSYS 把 `/` 前缀参数改写成路径——用双斜杠 `//PID` 或前缀 `MSYS_NO_PATHCONV=1`；`/tmp` 仅 MSYS 内有效，原生程序传 workspace 路径；bash `kill` 杀不死 Windows 原生进程；中文系统下原生程序向管道输出 GBK，结果里的 U+FFFD/杂字是编码噪声而非损坏，读 ASCII/数字骨架）。Windows 两条官方没有也不会有（官方 bash 在 win32 被 disable）——依据 session 语料分析：GBK 噪声确凿命中 37/106 个 session，且模型的浪费集中在「不知道乱码是编码层现象」的反复自查；`PYTHONIOENCODING=utf-8 python` 等依赖项目环境的补救留在项目级文档，系统提示词只放平台事实
- **超时可配置**：`timeoutMs` / `maxTimeoutMs` 进 Config（默认 120000 / 上限 600000，对齐官方 `dsh-bash-local` 口径），生效值 = `min(请求值 ?? timeoutMs, maxTimeoutMs)`，请求值仍可低于上限；此前模型可以要求任意长的超时定时器
- **参数按能力动态注册**：`run_in_background` 仅在 jobs 服务存在时进 schema，`sandbox_permissions`/`justification` 仅在有沙箱升级面时进 schema，`timeoutMs` 描述双态（promote 可用时承诺「超时转后台而非被杀」）——缺失能力的组合里模型不再调到硬错误白费一轮重试（能力组合期固定，注册时算一次）
- **结果标记对齐官方**：`[timed out]` → `[timed out after <N>ms]`（模型可判断「差一点跑完」还是「远不够」）；补 `[killed by signal: X]`（signal 分支优先、exit code 分支在后，与官方 `renderResult` 互斥顺序一致）；移除不可达的 `[aborted]` 分支（aborted 调用走 throw，不产出 result）
- **dsh 依赖重解析到 `0.2.2-rc.5`**：`package-lock.json` 里 `@deepseek-ai/dsh-llm` / `dsh-sandbox` / `dsh-tools` 及 devDependencies 的 dsh 各包自 0.2.2-rc.1 时代冻结至今；manifest 范围 `>=0.2.2-rc.1 <0.3.0-0` 本就覆盖 rc.5，无需改 manifest，仅 `npm update` 重解析 lock。此前冻结的 rc.1 副本会在 `link:` 加载时被 Node 从插件自己的 node_modules 解析，与 rc.5 运行时混装。已在 dsh `0.2.2-rc.5` 宿主真机启动验证（`dsh web` 正常引导、插件激活、服务可响应）

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

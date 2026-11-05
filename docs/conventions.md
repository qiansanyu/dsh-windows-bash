# 插件编写规范与常见失败速查

本插件开发过程中踩过的坑与沉淀的规范（2026-08 至 2026-10 实测）。

## DSH 0.2.0 架构变更（2026-10 适配）

配置系统整体重构，旧 API 全部失效：

- **`installSettingsSection` / `settings.installSection` 均已移除**：插件不再注册 settings namespace。配置由 **Plugin Config schema 自动投影**成表单（`SettingsForms`，`settings.describe()` 逐个 entry 生成 descriptor）
- **live 配置字段必须标 `.volatile()`**：`volatileForm(schema)` 只投影带 `meta.volatile` 的字段。未标记 → 设置页不显示该插件、`settings.mutate` 写入报 `Config field "x" is not volatile`
- **配置 namespace = profile entry id**（不再是插件自定义名字）：`settings.mutate(entryId, ops)` / `settings.update(entryId, patch)`
- **volatile 读取**：字段值是 `Volatile<T>` 引用，读时解包（`value.get()`；结构检测即可，避免 cosmokit 包名不匹配）
- **settings.yaml 废弃**：启动时自动迁移到 profile 的 entry config，随后重命名为 `.imported`
- **`settings.configure({ auto })`** 控制是否自动生成配置页（默认 true；`auto: false` 表示插件自己提供 UI）
- **插件管理页（ui-plugin-manager，新包）**：官方插件配置入口走 `plugins.item`；**第三方 bundle 自己的配置页要注册 `plugins.bundle.config`（keyed，key = bundle 包名）**，渲染在插件详情页内（`view: 'page'`）；行级配置走 `plugins.row.config`（key = `<包名>#<rowId>`）
- **`sandbox.confine` 变异步**（返回 `Promise<ConfinedArgv>`，需 await）
- **`jobs.start` 的 `owner` 从 `Agent` 实例改为 `SessionId`**（传 `exec.agent.id`）
- 官方参考实现：`packages/experimental/client-ui-voice-input`（bundle 配置页注册的最佳示例）

## 构建

- 构建依赖不再 junction 到 dsh 安装/checkout：junction 目标会随 dsh 升级静默变化；改为 `npm install` 真实下载，7 个 `@deepseek-ai/dsh-*` 在 devDependencies 钉到与运行时一致的精确版本（当前 `0.2.0-rc.2`，对齐 dsh 官方 package.json 的精确版本写法），`package-lock.json` 提交进库保证可复现；dsh 升级时显式改版本 → 重装 → 重编，漂移变成主动动作
- **必须 `legacy-peer-deps`**（`.npmrc` 已固定）：peer 范围（`>=0.0.1-rc <2`）按 semver 规则无法被 `0.2.0-rc.2` 满足（node-semver 把 `-rc` 版本当 prerelease，且 registry 无稳定发布线），npm 7+ 自动装 peer 会另装旧稳定版或 EOVERRIDE 失败；`overrides` 方案同样会 EOVERRIDE（override 值与 peer 范围冲突）
- `scripts/build.sh` 探测 `DSH_CHECKOUT`（env → 常见路径），junction link 编译依赖（cordis/schemastery/dsh-tools/dsh-subprocess/dsh-settings 等）后 tsc 编译 host；本仓库已改用 npm install，build.sh 仅作 checkout 开发环境的备选
- client 用 tsdown 编译为 `lib/client.js`（`window.__ModuleLoader__.load` 注册）；tsdown 从 checkout 的 `node_modules/tsdown/dist/run.mjs` 直接跑（`.bin/tsdown` shell shim 在 git-bash 下有 MSYS 路径转换问题）
- tsconfig 必须 `exclude: ["src/client"]`——host tsc 编译 client 会因 react 等浏览器依赖报 TS2307
- **发布前手动构建 + `npm publish --ignore-scripts`**：`prepublishOnly` 里的 `bash scripts/build.sh` 在 cmd.exe 环境下因 bash 不在 PATH 而失败（已在 package.json 移除该钩子）

## Host 侧

- 动态注册/注销工具：`ctx.tools.register(defineTool(...))` 返回 disposer，切换时调用注销；插件卸载时也要注销（`ctx.effect` 清理）
- 工具重名报错：同 scope 内 `tool "x" is already registered`；host 层与 preset 层是不同 scope，可同名共存
- `defineTool` 的 output.schema 嵌套 object 必须带 `additionalProperties: false`，否则类型推断为 never
- `ctx.webServer` 等 host 服务类型需自行声明（`AppContext` 交叉类型），未 import 对应包时 cordis Context 类型合并不生效
- settings 注册（0.1.x 旧法，0.2.0 已移除）：`installSettingsSection(ctx, ns, schema, entry, hooks)`；0.2.0 见上文「DSH 0.2.0 架构变更」
- settings 的 client 端 RPC 有 apiproxy allowlist（`WEB_SETTINGS_NAMESPACES`），插件自行注册的 namespace 不会被 serve 给浏览器——client 卡片读写需走插件自己的 host API，host 端仍经 settings 服务持久化
- 插件自有 host API 必须自行做来源准入：裸 `webServer.register` 的前缀路由不在 `client-connection` 的 token/cookie 伞下（其准入只覆盖 connection 自己注册的路由），handler 入口要校验 `Origin`/`Host` 为回环（本插件 `isLocalGuiRequest`），否则跨站页面可经 simple request 静默改写配置
- `system-prompt/assemble` 是 waterfall：必须 `await next()` 再变换（0.2.1 及之前用来裁工具面——**0.2.2-alpha.2 起载荷不再含 `tools`**，这条路已关闭，改用 per-agent `tools.restrict`）；host 层无 scope tag 的 listener 全局接收所有 scope 的事件（`scopeTarget` 的 filter 对无 tag listener 放行）
- 系统提示文本（sections）按会话快照注入，工具面（restriction / 注册）按请求刷新——引导文本新会话生效，工具面收敛当前会话即生效

## Client 侧

- `apply` 用 `ctx.slots` 必须 `export const inject = ['slots']`（服务注入声明），否则报 `cannot get property 'slots' without inject`
- `ctx.slots.register` 必须带 `name` 字段（= slot 名），缺 name 报 `slot undefined is not declared`
- slot 组件是 React 组件（`SlotComponent<P> = (props: P) => ReactNode`）；用 `React.createElement` 手写可避免 tsx/jsx 构建配置
- **0.2.0 配置页注册**：`plugins.bundle.config`（keyed，key = bundle 包名，`view: 'page'` 渲染表单、`view: 'summary'` 一行摘要）；旧 `settings.plugin.item` 槽位已删除，但仍保留注册（`slots.inject` 对未声明槽位不执行回调，无副作用，兼容 0.1.x）
- 折叠卡片模式（官方 PluginCard 同构）：头部 button（aria-expanded）+ chevron 旋转 + 展开 body + footer 保存/放弃；dirty 时头部「未保存」标记；样式用官方 CSS 变量（`--dsw-alias-*`）
- **React inline style 不要用 `border` 简写**：CSS 变量在简写里会被拆解丢失（border-color 回落 `currentColor` 黑色），必须用 `borderWidth`/`borderStyle`/`borderColor` 长写
- 终端卡片展示：工具实现 `presentCall`（card:'terminal'，title=命令）+ `presentResult`（解析输出末尾 `[exit code: N]` 标记拆出 exit pill）；exit 标记必须在输出**末尾**（`parseExitStatus` 锚定末尾），exit 0 不报标记

## 注入器

- `dev_inject_plugin`：junction + `loader.create`，host 层装配，免重启；client 模块经 client-modules 增量补扫注册，浏览器刷新后拉取新 bundle
- `dev_reload_package`：清缓存 + 重建 fiber，失败回滚保留旧代
- `dev_uninject_plugin`：卸 entry + 清 registry + 删 junction + patch disabled 条目，卸载即净
- 注入是运行时的：重启 web 后需重新注入；持久化用 `dev_install_package`（写 profile bundles）或正式安装（`dsh plugin add` + bundle patch）

## link 安装的运行期依赖闭包

- `dsh plugin add link:<目录>` 在 profile `node_modules` 里建的是 **junction**；Node 按 realpath 解析 → 插件及其**全部间接依赖都从插件项目自己的 node_modules 解析**，宿主导入的 dsh 副本帮不上忙（实测：报错栈落在 `<项目>\node_modules\@deepseek-ai\dsh-tools\lib\index.js`）
- 0.1.0 起改了打包口径：4 个**运行期** import（`schemastery`、`dsh-tools`、`dsh-llm`、`dsh-sandbox`）放在 **dependencies**（range `>=0.2.2-rc.1 <0.3.0-0`），由选择它们的那份 lockfile 决定版本；只被类型引用的包装在 devDependencies。这样 `dsh plugin add github:…` 装进来时依赖会被真实安装，不会出现"插件自带一份 0.2.0-rc.2、运行时却按 0.2.2 崩"的错配（0.0.7 的崩溃根因之一）
- 仍要留意的旧坑：`legacy-peer-deps=true` 不装 peer，而 dsh-* 包的 peer 在运行时会被真实 import（如 `dsh-tools` import `@deepseek-ai/dsh-scope`）——runtime deps 放 dependencies 后由 npm 自己展开闭包；只有**从 git 安装时**才需要确认这一点
- 闭包自查（read-only）：从 4 个真实 import 出发 BFS 遍历 dependencies+peerDependencies，报 `node_modules` 缺失项；补到 0 缺失
- **排查 "failed to import" 的标准姿势**：boot audit 只在 `entry.fiber === undefined` 时报 "failed to import"（import 抛异常时 loader 只 `logger.error`，真实错误被吞）。在 profile 目录 `node --input-type=module -e "import('<包名>')..."` 直接复现真实错误（注意动态 import 的基准是**启动时**的 cwd，`process.chdir` 无效，要用 shell workdir）
- **schemastery 必须用 fork，且版本要跟宿主那条线**：普通 `schemastery@3.18.x` 没有 `Schema.prototype.volatile`（volatile 配置必需），报 `z.union(...).default(...).volatile is not a function`。用 npm alias：`"schemastery": "npm:@deepseek-ai/schemastery@~3.19.0"`（dsh 0.2.2-rc.1 用的是 3.19.0；与 `dsh-tools` 的 `~3.19.0` 对齐才不会装出两份、也不会让 `tsc` 报 TS2742「inferred type cannot be named」）——import 写法 `import z from 'schemastery'` 不用动，与宿主同实现
- 包内容变更不过 HMR：改完 lib 要重启 `dsh web`（patch 文件才热重载）

## bash-on-Windows 与沙箱 confined 模式的硬冲突（2026-10 实测定位）

- **MSYS git-bash 在 read-only / workspace-write 下必死**：启动即 `fatal error - couldn't create signal pipe, Win32 error 5`（ACCESS_DENIED）。MSYS 运行时启动时必须创建**命名管道**（signal pipe）做信号处理，Windows ACL 沙箱的受限 token 让命名管道创建访问检查必败。官方 README「Known boundaries」：命名管道走 Win32 默认 SD 模板、不携带任何 restricting SID 授权；匿名管道能过只因受限 token 默认 DACL 带了 full-access ACE，所以 PowerShell 管道不受影响。这是沙箱硬边界，不可也不应绕过（绕过 = 脱离沙箱执行）；官方 Windows confined 执行器本来就只有 pwsh（base patch 里 bash 系全 disabled）。danger-full-access 下 bash 全功能正常
- 本插件处置（`auto` 的语义 = **可用性**而非存在性）：`bashViableInMode`——confined 模式判不可用；per-agent `tools.restrict` 回落（confined 会话模型视野只给 `pwsh`；0.2.2 起不再用 assemble 层裁剪）；execute 层拦缺（`BASH_UNAVAILABLE` 可读报错，覆盖 hooks 旁路）；status 报组合默认模式
- **新会话默认 confined**：`dsh-sandbox-policy` 的 "File-sandbox mode a session starts from" 默认 `read-only`——新开 GUI 会话不切预设就是只读
- **per-session 取数路径**：`AssembleContext` 只有 `scope`/`signal`，没有 session；scope key **就是 agent loop 对象本身**（dsh-agent-loop `createScope(loopCtx, this)`，构造器里 `this.session = session`），所以 `(scope).session` 即 `Session` → `sandboxPolicy.resolve({ session }).mode`
- 排查姿势：confined 死 / unconfined 好的对照实验（同一条 bash 命令切模式跑两遍）比读码更快定位沙箱边界

## 发布

- bundle patch 装配：包内 `cordis.patch.yml`（insert 插件行）+ package.json `dsh.bundle.patch` 声明，`dsh plugin add github:...` 一条命令正式安装
- npm 发布：`files` 清单（lib + cordis.patch.yml + LICENSE）、去 `private`；**发布前手动构建**（`prepublishOnly` 里的 bash 在 cmd 下失败，已移除）
- **npm staged publishing**：新版 npm 的发布可能需要暂存/批准，`npm publish` 返回成功但 registry 未立即出现；此时重复发布会报 `E409 Cannot publish over previously staged version`。等几分钟版本会落地，或在 npm 网站批准；**换一个补丁版本号也是最快的绕过方式**
- Release 资产：ZIP（lib + cordis.patch.yml + package.json + LICENSE），用户解压后 `dsh plugin add link:<目录>`

## 桌面端与 web 端

- **两套独立实例**：桌面应用（Electron，`AppData\Local\Programs\DeepSeek Harness`）用 `~/.dsh/profiles/desktop`；`dsh web` 服务用 `~/.dsh/profiles/web`——各自的 bundles/插件/会话，互不相通
- 插件要两端都生效，**两边的 profile 都要装配**（package.json 的 dependencies + bundles + node_modules junction）
- 桌面 GUI 的静态资源与首页需要认证（`dsh web authentication required`），未带 token 的 curl 探测会得到 404/认证提示，**不能据此判断 client bundle 缺失**
- 桌面端验证 client 的正确方式：在应用内打开「插件管理 → 已安装 → 点击插件 → 详情页」查看

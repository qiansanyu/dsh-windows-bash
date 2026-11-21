# DSH Host 能力清单（本插件用到的）

本插件 host 侧消费的 DSH Host 服务与事件（2026-11 修订，基于 dsh 0.2.2-rc.5）。

## 服务（inject）

| 服务 | 提供包 | 本插件用途 |
| --- | --- | --- |
| `tools` | `@deepseek-ai/dsh-tools` | `register(defineTool(...))` 动态注册 bash 工具，返回 disposer 切换时注销 |
| `subprocess` | `@deepseek-ai/dsh-subprocess-local` | `spawn({argv, cwd, stdio, graceMs, signal, env})` 执行 git-bash；collect 模式输出截断 + spill |
| `systemPrompt` | `@deepseek-ai/dsh-system-prompt` | `section({name, order, text})` 注册引导文本（`text` 每次 assembly 求值，返回空串即不注入）；**不再**用 `system-prompt/assemble` 裁工具面 |
| `webServer` | `@deepseek-ai/dsh-host-webserver` | `register({kind:'prefix', path, handler})` 提供卡片读写 API |
| `settings` | `@deepseek-ai/dsh-settings-file` | `settings.mutate(entryId, ops)` 持久化 preferred / bashPath（namespace = profile entry id；0.1.x 的 `installSettingsSection` 已随 0.2.0 移除） |

## 事件

| 事件 | 模式 | 本插件用途 |
| --- | --- | --- |
| `agent/created` | serial | agent 新建 / resume / clear / 压缩后、首轮之前：per-agent 同步工具面 |
| `agent/status` | emit | 状态转 `running` 时再同步一次（切权限预设后下一轮生效） |
| `agent/inbox/inserted` | emit | 每次提交前同步（同轮生效） |
| `agent/disposed` | emit | 撤销该 agent 的 restriction |

> `system-prompt/assemble` 自 **0.2.2-alpha.2** 起载荷是 `PromptPresentation`（`sections`/`contexts`/`variables`），
> **不含 `tools`**——工具声明归 provider，瀑布之后才拼回 `PromptAssembly`。
> 因此"在瀑布里裁工具"这条路在 0.2.2 上已关闭（`assembled.tools.filter` 会是 `undefined.filter`）。

## 关键机制

- **工具注册**：`ctx.tools.register` 返回 disposer；同 scope 重名报错；host 层与 preset 层不同 scope 可同名
- **工具 schema 按请求刷新**：注册/注销后下一次请求的工具面变化（当前请求不变）
- **工具面限制**：`tools.restrict({allow?, deny?})` 只能在**调用方作用域**调用（全局调用抛 "requires a scoped context"）；名字必须是已知全局工具（否则抛 unknown name）；多条 restriction 取交集；scope 自己注册的工具豁免
- **系统提示按会话快照**：sections 在会话开始时注入，新会话才看到新 section
- **settings allowlist**：apiproxy 的 `WEB_SETTINGS_NAMESPACES` 决定哪些 namespace 可被 client 端 RPC 读写；插件自行注册的 namespace 不在其中（官方 deferred work）
- **scope 事件过滤**：`scopeTarget` 的 filter 对无 scope tag 的 listener 放行（host 层 listener 全局接收 agent scope 事件）

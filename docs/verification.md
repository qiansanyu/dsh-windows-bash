# 验收：这个插件"怎么算能用"

本插件的产品承诺只有一条：**模型手里始终有且只有一个真能跑的 shell 工具**。
下面四组场景就是这句话的可执行版本；判据全部落在会话日志上，不靠"看起来没报错"。

## 取证据：会话日志里的两条记录

`<DSH_HOME>/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd` 是 **zstd 多帧**追加写，
`zlib.zstdDecompressSync()` 只解第一帧（表现为"只有 session header"）。按 magic `28 b5 2f fd` 切帧逐帧解，
然后看：

- `request/header` → `data.header.tools[].name`：**真正下发给模型的工具名**（判据在这，不在 UI）
- `turn/end` → `data.reason`：`{"kind":"completed"}` / `{"kind":"error", …}`

> `dsh-agent-loop` 在 `assemble` 阶段抛错时会收敛成 `turn/end.reason.error{code:'UNKNOWN'}`，
> 所以"UI 显示本轮运行失败 + UNKNOWN"几乎一定是宿主契约问题，而不是模型调用失败。

## 四组场景

| # | 环境 | 期望 |
| --- | --- | --- |
| 1 | `DSH_PERMISSION_MODE=danger-full-access`，`preferred: auto`（探测到 git-bash） | `tools` 含 `bash`、**不含** `pwsh`；真跑一条命令成功；`turn/end` completed |
| 2 | 组合默认（`read-only` / `workspace-write`，即 confined） | `tools` 含 `pwsh`、**不含** `bash`；`turn/end` completed（MSYS 在 confined 下起不来，必须回落） |
| 3 | 会话中途把 `preferred` 切成 `pwsh`（走真实卡片的后端路径） | 下一轮 `tools` 含 `pwsh`、不含 `bash`；**不能一个 shell 都不剩**（这条最容易写错：注销 bash 的同时必须把 `deny:['pwsh']` 撤掉） |
| 4 | `preferred: pwsh` 冷启动 | 与 3 相同；并且日志里没有 "names unknown global tool" 之类的 restrict 报错（bash 没注册时不能去 deny 它） |

场景 3 可以纯 HTTP 驱动（卡片后端就是它）：

```sh
curl -s -X POST http://127.0.0.1:<port>/dsh-windows-bash/api/preferred \
  -H 'content-type: application/json' -H 'origin: http://127.0.0.1:<port>' \
  -d '{"preferred":"pwsh"}'
# {"ok":true,"preferred":"pwsh","effective":"pwsh"}
```

## 隔离做法（不要拿真实 profile 试）

```sh
H=$TEMP/dsh-wp1                       # 临时 DSH_HOME
mkdir -p $H/profiles/web && cp ~/.dsh/.credentials.yaml $H/
printf '{"name":"dsh-profile-web","private":true,"dependencies":{},"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app"]}}}\n' > $H/profiles/web/package.json
DSH_HOME=$(cygpath -w $H) dsh plugin --profile web add <本仓库目录>
DSH_HOME=$(cygpath -w $H) dsh web --no-open --port 4123
```

profile patch 里至少要有：`agent-preset-registry.default: standard`（本插件的前提是官方 `tool-pwsh` 在该
preset 里启用）、本插件自己那条 `- id: dsh-windows-bash` 配置，以及 `ui-settings-general.welcomeNoticeVersion`
（否则首启的"预览版说明"弹窗会盖住 composer）。

## 已知未覆盖

- **同一 turn 的后续 step 中途切沙箱预设**：restriction 在 `agent/status→running` 与每次提交前重算，
  所以是"下一轮/下次提交"生效（旧实现在每个 step 的 assemble 里换 schema，但执行准入集合没换，本身不一致）
- 持久终端组件（本插件不提供）；后台作业大输出的 spill 全量路径已自 0.1.1 起覆盖（截断时在 stdout/stderr 末尾回传 spill 文件路径）

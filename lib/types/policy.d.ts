/**
 * Shell 工具面的隐藏判定（纯函数，可单测）。
 *
 * 为什么单独成文件：这条判定以前写死在 `system-prompt/assemble` 的 waterfall 里。
 * 0.2.2-alpha.2 起该事件的载荷改成 `PromptPresentation`（sections / contexts /
 * variables），**不再包含 `tools`**——工具声明归 provider 所有，瀑布之后才拼回去。
 * 判定搬到 per-agent `tools.restrict` 之后，载体变了、语义没变；
 * 把它抽成纯函数，机制再换也不用重新论证语义。
 */
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';
/** 需要从模型视野里隐藏的那个 shell 工具。 */
export type HideTarget = 'pwsh' | 'bash';
/**
 * 某沙箱模式下 MSYS git-bash 能否启动。
 *
 * confined 模式（`read-only` / `workspace-write`）下**不能**：MSYS 运行时启动时必须
 * 创建命名管道（signal pipe）做信号处理，而 Windows ACL 沙箱的受限 token 让命名管道
 * 的创建访问检查必败（官方 README「Known boundaries」：命名管道走 Win32 默认 SD 模板、
 * 不携带任何 restricting SID 授权）——bash 直接 fatal error（Win32 error 5）。
 * 这是沙箱的硬边界，不可也不应绕过（绕过等于脱离沙箱执行）。
 * `undefined` mode 表示无 sandboxPolicy 服务（无约束组合），按可用处理。
 */
export declare function bashViableInMode(mode: SandboxMode | undefined): boolean;
/**
 * 本 agent 应该隐藏哪个 shell 工具。
 *
 * - `effective=pwsh`：bash 工具根本没注册，没有东西需要隐藏——也不能 deny 一个不存在的
 *   全局工具名，`tools.restrict()` 会因此抛错（"names unknown global tool"）。
 * - `effective=bash` 且该会话能启动 MSYS：隐藏官方 `pwsh`，模型只看得到 bash。
 * - `effective=bash` 但会话处于 confined：git-bash 起不来，隐藏 `bash`、回落官方 `pwsh`，
 *   保证模型手里始终是那个真能跑的 shell。
 *
 * @param effective - 当前生效的 shell 策略（探测 + 配置的合成结果）。
 * @param mode - 该 agent 的 standing 沙箱模式，`undefined` 表示组合里没有 sandboxPolicy。
 * @returns 需要 deny 的工具名，或 `undefined` 表示无需限制。
 */
export declare function desiredHide(effective: 'bash' | 'pwsh', mode: SandboxMode | undefined): HideTarget | undefined;

/**
 * dsh-windows-shell-policy — Windows 默认 Shell 策略组合插件（host 侧）。
 *
 * 职责：
 * 1. 探测 git-bash / MSYS2 / Cygwin 可执行文件（显式 bashPath → 常见安装路径 → PATH）。
 * 2. 通过 settings namespace `shell-policy` 暴露 preferred（auto/bash/pwsh）与
 *    bashPath 配置，在「设置 - 插件 - 插件配置」面板由 client 卡片编辑。
 * 3. 策略生效：effective=bash 时动态注册 `bash` 工具（git-bash 执行），并用 per-agent
 *    `tools.restrict({deny})` 隐藏 `pwsh`；effective=pwsh 时注销 bash 工具（官方
 *    tool-pwsh 继续工作）。confined 会话自动回落 pwsh —— 判定见 policy.ts。
 * 4. bash 工具对齐官方 shell 工具：session cwd 解析、文件沙箱（confine +
 *    sandbox_permissions 升级）、run_in_background（jobs 通道）、终端卡片展示。
 * 5. 提供 /dsh-shell-policy/api 供 client 卡片读写状态与配置（仅接受本机 GUI 来源请求）。
 * 6. 非 Windows 平台直接跳过（DSH 默认 bash 工具已可用），仅保留状态 API。
 */
import type { Context, Volatile } from 'cordis'
import z from 'schemastery'
import { defineTool, TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
// 引入 loader 的事件类型增强：'loader/volatile-update' 等事件声明在
// cordis-plugin-loader 的 `declare module '@deepseek-ai/cordis'` 里，
// 不引用其类型文件 ctx.on('loader/volatile-update') 会 TS2345。
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import { ESCALATION_TARGETS, approveEscalation, sandboxDenialMarker, validateEscalationArgs } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
// agent 事件（agent/created、agent/status、agent/inbox/inserted、agent/disposed）
// 与 Agent.ctx 的声明都在这个包里；`bashViableInMode` / `desiredHide` 见 policy.ts。
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bashViableInMode, desiredHide, type HideTarget } from './policy.js'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    bash: 'bash'
  }
}

export const name = 'dsh-windows-shell-policy'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'webServer']

/** 本插件的包名（也是 profile entry 的 name，用于解析自身 entry id）。 */
const PKG_NAME = 'dsh-windows-shell-policy'

/**
 * 解析本插件在 profile 中的 entry id。
 * DSH 0.2.0 起 settings 的配置 namespace 即 profile entry id（插件 Config schema
 * 自动投影为表单），不再有插件自定义 namespace 的注册机制。
 */
function resolveOwnEntryId(ctx: Context): string | undefined {
  const loader = (ctx as {
    loader?: { entries(): Iterable<{ options?: { id?: unknown; name?: unknown } }> }
  }).loader
  if (loader === undefined || typeof loader.entries !== 'function') return undefined
  for (const entry of loader.entries()) {
    const options = entry.options
    if (options !== undefined && String(options.name ?? '') === PKG_NAME && typeof options.id === 'string') {
      return options.id
    }
  }
  return undefined
}

export interface Config {
  /**
   * 首选 shell：auto（探测到 bash 则用 bash，否则 pwsh）/ bash / pwsh。
   * DSH 0.2.0 起 live 配置必须是 volatile 引用（settings 从 Config schema 投影表单），
   * 读取时用 {@link unwrapVolatile} 解包。
   */
  preferred: Volatile<'auto' | 'bash' | 'pwsh'>
  /** 显式 bash 可执行文件路径；留空则自动探测。 */
  bashPath: Volatile<string>
}

export const Config = z.object({
  preferred: z.union([z.const('auto'), z.const('bash'), z.const('pwsh')]).default('auto').volatile(),
  bashPath: z.string().default('').volatile(),
})

/** 插件 apply 收到的原始 config（volatile 字段为引用对象）。 */
type RawConfig = { preferred: unknown; bashPath: unknown }

/** 解包 volatile 引用（结构检测：带 get() 的引用对象；非引用值原样返回）。 */
function unwrapVolatile<T>(value: unknown): T {
  if (typeof value === 'object' && value !== null && typeof (value as { get?: unknown }).get === 'function') {
    return (value as { get(): T }).get()
  }
  return value as T
}

type ResolvedConfig = { preferred: 'auto' | 'bash' | 'pwsh'; bashPath: string }

/** 从原始 config 读当前生效值（每次调用都取 volatile 最新快照）。 */
function readConfig(raw: RawConfig): ResolvedConfig {
  const preferred = unwrapVolatile(raw.preferred)
  const bashPath = unwrapVolatile(raw.bashPath)
  return {
    preferred: preferred === 'bash' || preferred === 'pwsh' ? preferred : 'auto',
    bashPath: typeof bashPath === 'string' ? bashPath : '',
  }
}

/** bash 探测结果。 */
interface BashProbe {
  found: boolean
  path: string
}

/** 探测 bash 可执行文件：显式路径 → 常见安装位置 → PATH。 */
function probeBash(explicit: string): BashProbe {
  if (explicit.length > 0) {
    return existsSync(explicit) ? { found: true, path: explicit } : { found: false, path: explicit }
  }
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const candidates = [
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    'C:\\msys64\\usr\\bin\\bash.exe',
    'C:\\cygwin64\\bin\\bash.exe',
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { found: true, path: candidate }
  }
  for (const entry of (process.env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    const candidate = join(trimmed, 'bash.exe')
    if (existsSync(candidate)) return { found: true, path: candidate }
  }
  return { found: false, path: '' }
}

/** 从进程环境挑出 DSH_* 托管变量传给子进程。 */
function collectDshEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_') && value !== undefined) env[key] = value
  }
  return env
}

/**
 * 面向模型的终端环境覆盖：关颜色、关分页器、关交互终端特性，防止
 * pager 挂起命令或 ANSI 转义序列污染工具输出。与官方 dsh-bash-local 的
 * ENV_OVERRIDES 对齐；subprocess 服务将调用方 env 合并在清除凭据后的
 * 父环境之上，故在此声明即生效（DSH_* 无键冲突，声明顺序无关）。
 */
const MODEL_ENV_OVERRIDES: Record<string, string> = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
}

/** 回环主机名：localhost、::1、127.0.0.0/8。 */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host)
}

/**
 * 状态/配置 API 的请求准入：只服务本机 GUI 自身来源的请求。
 * - 带 `Origin` 头（浏览器跨站 fetch、表单 POST 均会带）：origin 主机必须是回环，
 *   否则是跨站页面经 simple request（text/plain 表单 POST 无需预检）静默改写配置；
 * - 不带 `Origin`（同源 GET、本地脚本）：`Host` 头必须是回环，
 *   否则挡掉把 Host 指向外部域名的 DNS rebinding 类请求。
 * 本路由是裸 webServer 前缀路由，不在 client-connection 的 token/cookie 伞下
 * （Host API 的鉴权只覆盖 connection 自己注册的路由），故在此自行准入。
 */
function isLocalGuiRequest(req: { headers?: Record<string, unknown> }): boolean {
  const origin = req.headers?.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      return isLoopbackHostname(new URL(origin).hostname)
    } catch {
      return false
    }
  }
  const host = req.headers?.host
  if (typeof host !== 'string' || host.length === 0) return false
  try {
    return isLoopbackHostname(new URL(`http://${host}`).hostname)
  } catch {
    return false
  }
}


/**
 * 解析某个 scope key（或 Agent）的 standing 沙箱模式。
 *
 * scope key 即 agent loop 对象本身（dsh-agent-loop `createScope(loopCtx, this)`，
 * 构造器里 `this.session = session`），所以 `scope.session` 就是 Session；
 * 拿不到 session 时退化为组合默认（`resolve({})`）。dsh-system-prompt 的
 * AssembleContext 只带 scope/signal，session 只能经此路径获得。
 * agent 生命周期钩子手里没有 assemble context，但它们拿到的 `Agent`
 * 同样暴露 `session`，所以两条路径共用这个函数。
 */
function sessionSandboxMode(ctx: AppContext, scope: unknown): SandboxMode | undefined {
  const sandboxPolicy = ctx.get('sandboxPolicy') as SandboxPolicyService | undefined
  if (sandboxPolicy === undefined) return undefined
  const session = (scope as { session?: Session } | undefined | null)?.session
  return sandboxPolicy.resolve(session === undefined ? {} : { session }).mode
}

/** bash 工具结果形状。 */
interface BashResult {
  exitCode: number | null
  timedOut: boolean
  aborted: boolean
  stdout: { text: string; truncated: boolean }
  stderr: { text: string; truncated: boolean }
  sandbox?: { mode: string; denied: boolean }
}

/** 渲染 bash 工具结果文本（对齐官方 shell 工具：exit 标记在末尾，exit 0 不报）。 */
function renderBashResult(value: BashResult, escalationModes: readonly SandboxMode[]): string {
  let body = value.stdout.text
  if (value.stderr.text.length > 0) {
    if (body.length > 0 && !body.endsWith('\n')) body += '\n'
    body += `[stderr]\n${value.stderr.text}`
  }
  if (body.length === 0) body = '(no output)'
  const markers: string[] = []
  if (value.sandbox?.denied) {
    markers.push(sandboxDenialMarker(value.sandbox.mode as SandboxMode))
    if (escalationModes.length > 0) markers.push('[sandbox: escalation available — retry this exact command once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]')
  }
  if (value.timedOut) markers.push('[timed out]')
  if (value.aborted) markers.push('[aborted]')
  else if (value.exitCode !== null && value.exitCode !== 0) markers.push(`[exit code: ${value.exitCode}]`)
  if (markers.length === 0) return body
  if (!body.endsWith('\n')) body += '\n'
  return body + markers.join('\n')
}

/**
 * 从渲染结果末尾拆出 exit 状态（官方 parseExitStatus 的本地等价实现）：
 * 终端卡片把 exit 状态显示为独立 pill，标记须从输出体移除。
 */
function parseExitStatus(text: string): { body: string; exitCode?: number; signal?: string } {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) return { body: text.slice(0, signal.index), signal: signal[1] }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  return { body: text, exitCode: 0 }
}

/** bash 工具参数。 */
interface BashToolArgs {
  command: string
  description: string
  timeoutMs?: number
  workdir?: string
  run_in_background?: boolean
  sandbox_permissions?: string
  justification?: string
}

/** 本插件消费的 host 服务面（webServer 类型由本包声明）。 */
type AppContext = Context & {
  webServer: {
    register(spec: {
      kind: 'prefix'
      path: string
      handler: (req: any, res: { writeHead(code: number, headers: Record<string, string>): void; end(body: string): void }) => void | Promise<void>
    }): () => void
  }
}

export function apply(ctx: AppContext, config: Config): void {
  const isWindows = process.platform === 'win32'
  // 0.2.0 起 config 的 live 字段是 volatile 引用；读取一律经 readConfig(source())。
  const entry = config as unknown as RawConfig
  let source: () => RawConfig = () => entry
  let probe: BashProbe = probeBash(readConfig(entry).bashPath)
  let effective: 'bash' | 'pwsh' = 'pwsh'
  let bashDisposer: (() => void) | undefined
  let registerError: string | undefined

  /**
   * 每个 agent 当前挂着的工具面限制。
   *
   * `tools.restrict()` 只在**调用方作用域**生效（全局调用会抛 "requires a scoped
   * context"），所以隐藏必须按 agent 逐个做：key 是 Agent 实例，value 记住隐藏目标是
   * 谁、以及撤销用的 disposer。agent 释放后 WeakMap 自然回收，`agent/disposed`
   * 里再显式撤销一次（那之后 agent 作用域不再接受注册）。
   */
  const hides = new WeakMap<Agent, { name: HideTarget; dispose: () => void }>()

  /**
   * 把一个 agent 的工具面同步到当前策略。幂等；策略或会话沙箱模式没变时直接返回。
   *
   * 为什么不再用 `system-prompt/assemble`：0.2.2-alpha.2 起该 waterfall 的载荷是
   * `PromptPresentation`（sections / contexts / variables），**不含 `tools`**——工具
   * 声明归 provider 所有，瀑布之后才由 systemPrompt 拼回 `PromptAssembly`。旧实现在
   * 瀑布里 `assembled.tools.filter(...)`，在 0.2.2 上恒为 `undefined.filter`，
   * 每个 turn 的装配阶段直接抛 TypeError。
   *
   * 0.2.2 里隐藏另一个全局工具的官方途径只有 per-agent `tools.restrict()`：它同时
   * 收窄下发给模型的 schema 与**执行准入集合**（比旧版只删 schema 更彻底——模型硬调
   * 被隐藏的 shell 会被判 unknown）。
   */
  const syncAgent = (agent: Agent): void => {
    const want = desiredHide(effective, sessionSandboxMode(ctx, agent))
    const cur = hides.get(agent)
    if (cur?.name === want) return
    cur?.dispose()
    hides.delete(agent)
    if (want === undefined) return
    try {
      hides.set(agent, { name: want, dispose: agent.ctx.tools.restrict({ deny: [want] }) })
    } catch (error) {
      // 组合里没有这个工具是正常情况：preset 关掉了 tool-pwsh、bash 尚未注册、
      // 或该工具不是可限制的全局工具。旧版 filter 在这种情况下同样静默无效。
      ctx.logger.debug('[shell-policy] 无法隐藏 %s，跳过: %s', want, String(error))
    }
  }

  /** 按当前配置重新应用策略：探测 bash、切换工具注册。幂等。 */
  const applyPolicy = (): void => {
    const cfg = readConfig(source())
    probe = probeBash(cfg.bashPath)
    const wanted = cfg.preferred === 'auto' ? (probe.found ? 'bash' : 'pwsh') : cfg.preferred
    const next = wanted === 'bash' && probe.found ? 'bash' : 'pwsh'
    if (next === effective && (next !== 'bash' || bashDisposer !== undefined)) return
    effective = next
    if (effective === 'bash') {
      // 沙箱升级面是 composition 级事实（sandbox + sandboxPolicy 服务存在与否）。
      const escalationModes: readonly SandboxMode[] =
        ctx.get('sandbox') !== undefined && ctx.get('sandboxPolicy') !== undefined ? ESCALATION_TARGETS : []
      try {
        bashDisposer = ctx.tools.register(defineTool({
          name: 'bash',
          description: 'Execute a bash command (git-bash on Windows) and return its stdout/stderr. '
            + 'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — '
            + 'pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. '
            + 'Long output is truncated to its tail. '
            + 'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; '
            + 'read its output with `job_output` and stop it with `job_kill`.',
          parameters: {
            command: { type: 'string', required: true, description: 'The bash command to execute.' },
            description: {
              type: 'string',
              required: true,
              description: 'Clear, concise description of what this command does in active voice, '
                + '5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; '
                + '"git status" → "Show working tree status".',
            },
            timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Defaults to 120000; the command is killed on expiry.' },
            workdir: { type: 'string', description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.' },
            run_in_background: { type: 'boolean' as const, description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.' },
            sandbox_permissions: {
              type: 'string' as const,
              enum: [...ESCALATION_TARGETS],
              description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.',
            },
            justification: {
              type: 'string' as const,
              description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
            },
          },
          output: {
            schema: {
              oneOf: [
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    kind: { type: 'string', required: true, const: 'background' },
                    jobId: { type: 'string', required: true },
                  },
                },
                {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }] },
                    timedOut: { type: 'boolean', required: true },
                    aborted: { type: 'boolean', required: true },
                    stdout: {
                      type: 'object',
                      additionalProperties: false,
                      required: true,
                      properties: {
                        text: { type: 'string', required: true },
                        truncated: { type: 'boolean', required: true },
                      },
                    },
                    stderr: {
                      type: 'object',
                      additionalProperties: false,
                      required: true,
                      properties: {
                        text: { type: 'string', required: true },
                        truncated: { type: 'boolean', required: true },
                      },
                    },
                    sandbox: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        mode: { type: 'string', required: true },
                        denied: { type: 'boolean', required: true },
                      },
                    },
                  },
                },
              ],
            },
            render: (_args: unknown, value: unknown) => {
              const v = value as BashResult | { kind: 'background'; jobId: string }
              if (typeof v === 'object' && v !== null && 'kind' in v && v.kind === 'background') {
                return [{ type: 'text', text: `started background job ${v.jobId}` }]
              }
              return [{ type: 'text', text: renderBashResult(v as BashResult, escalationModes) }]
            },
          },
          async execute(args: BashToolArgs, exec) {
            if (args.command.trim().length === 0) {
              throw new Error('invalid command: expected a non-empty string')
            }
            if (args.description.trim().length === 0) {
              throw new Error('invalid description: expected a non-empty string')
            }
            validateEscalationArgs(args.sandbox_permissions, args.justification)

            // workdir：显式相对路径按 session cwd 解析；缺省用 session cwd。
            // 收敛成 const：spawnSpec 是闭包，let 变量的外层窄化不会被保留。
            const headerCwd = exec.agent?.session.header.cwd
            const rawWorkdir = args.workdir
            const workdir: string = rawWorkdir === undefined
              ? (headerCwd ?? process.cwd())
              : (headerCwd !== undefined && !isAbsolute(rawWorkdir) ? resolve(headerCwd, rawWorkdir) : rawWorkdir)

            // 沙箱策略：standing policy + 升级请求。
            const sandbox = ctx.get('sandbox')
            const sandboxPolicy: SandboxPolicyService | undefined = ctx.get('sandboxPolicy')
            const standingPolicy = sandboxPolicy?.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
            let policy: SandboxExecutionPolicy | undefined = standingPolicy
            if (args.sandbox_permissions !== undefined && args.justification !== undefined) {
              if (escalationModes.length === 0) {
                throw new Error('sandbox_permissions is not available in this composition (no sandboxing executor to escalate)')
              }
              const approvedMode = await approveEscalation(
                { requestedMode: args.sandbox_permissions, justification: args.justification, effectiveMode: (standingPolicy as SandboxExecutionPolicy).mode, subject: 'command' },
                {
                  approver: ctx.get('approval'),
                  agent: exec.agent,
                  callId: exec.callId,
                  toolName: 'bash',
                  signal: exec.signal,
                },
              )
              policy = { ...(standingPolicy as SandboxExecutionPolicy), mode: approvedMode }
            }

            // confined 模式兜底拦截：MSYS git-bash 在此模式下无法启动（其信号
            // 管道是命名管道，创建被 Windows ACL 沙箱拒绝，见 bashViableInMode）。
            // prompt 层已按 session 模式隐藏 bash（模型不该走到这里）；此处覆盖
            // 旁路调用（hooks-claude-code 等），给出可读原因而不是 fatal error。
            // 升级到 danger-full-access 且获批后 policy.mode 改变，自然放行。
            if (policy !== undefined && !bashViableInMode(policy.mode)) {
              throw new HarnessError(
                `git-bash cannot start under the "${policy.mode}" sandbox mode: the MSYS runtime's named signal pipe is denied by the Windows ACL sandbox (documented boundary of read-only/workspace-write confinement). Use the pwsh tool instead, or retry with sandbox_permissions "danger-full-access" plus a justification.`,
                'BASH_UNAVAILABLE',
              )
            }

            // argv 构造 + 沙箱 confine（DSH 0.2.0 起 confine 为异步）。
            let argv: string[] = [probe.path, '-c', args.command]
            let confined: ConfinedArgv | undefined
            if (policy !== undefined && policy.mode !== 'danger-full-access' && sandbox !== undefined) {
              confined = await sandbox.confine(argv, { ...policy, mode: policy.mode })
              argv = confined.argv
            }

            const collect = { maxBytes: 64_000, spill: { maxBytes: 64 * 1024 * 1024 } }
            const spawnSpec = (signal: AbortSignal | undefined): SubprocessSpawnSpec => ({
              argv,
              cwd: workdir,
              stdio: { stdin: 'ignore', stdout: collect, stderr: collect },
              graceMs: 3_000,
              signal,
              env: { ...MODEL_ENV_OVERRIDES, ...collectDshEnv() },
            })

            // 后台：jobs 通道，cancel/readOutput 增量。
            if (args.run_in_background === true) {
              const jobs = ctx.get('jobs')
              if (jobs === undefined) {
                throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
              }
              if (exec.signal.aborted) {
                const error = new HarnessError('tool call aborted', TOOL_ABORTED)
                error.name = 'AbortError'
                throw error
              }
              const id = jobs.start({
                kind: 'bash',
                label: args.command,
                // DSH 0.2.0 起 owner 为 SessionId（不再是 Agent 实例）。
                ...exec.agent ? { owner: exec.agent.id } : {},
                run: () => {
                  const handle = ctx.subprocess.spawn(spawnSpec(undefined))
                  let stdoutOffset = 0
                  let stderrOffset = 0
                  return {
                    cancel: () => handle.terminate(),
                    done: handle.done.then((outcome): JobOutcome => ({
                      status: outcome.exitCode === 0 ? 'completed' : 'failed',
                      detail: `exit code: ${outcome.exitCode}`,
                    })),
                    readOutput: () => {
                      const out = handle.collected.stdout?.readFrom(stdoutOffset)
                      const err = handle.collected.stderr?.readFrom(stderrOffset)
                      stdoutOffset = out?.nextOffset ?? stdoutOffset
                      stderrOffset = err?.nextOffset ?? stderrOffset
                      const outText = out?.text ?? ''
                      const errText = err?.text ?? ''
                      const separator = outText.length > 0 && !outText.endsWith('\n') ? '\n' : ''
                      return outText + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : '')
                    },
                  }
                },
              })
              return { kind: 'background' as const, jobId: id }
            }

            // 前台。
            const timeoutMs = args.timeoutMs !== undefined && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
              ? args.timeoutMs
              : 120_000
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), timeoutMs)
            const onAbort = (): void => controller.abort()
            exec.signal?.addEventListener('abort', onAbort)
            try {
              const handle = ctx.subprocess.spawn(spawnSpec(controller.signal))
              const outcome = await handle.done
              const out = handle.collected.stdout?.readFrom(0)
              const err = handle.collected.stderr?.readFrom(0)
              const stderrText = err?.text ?? ''
              const denied = confined !== undefined
                && outcome.exitCode !== 0
                && confined.denialSignatures.some((signature) => stderrText.toLowerCase().includes(signature.toLowerCase()))
              const result: BashResult = {
                exitCode: outcome.exitCode,
                timedOut: controller.signal.aborted && exec.signal?.aborted !== true,
                aborted: exec.signal?.aborted === true,
                stdout: { text: out?.text ?? '', truncated: out?.lossy ?? false },
                stderr: { text: stderrText, truncated: err?.lossy ?? false },
                ...denied ? { sandbox: { mode: policy?.mode ?? 'read-only', denied: true } } : {},
              }
              if (result.aborted) {
                const error = new HarnessError('tool call aborted', TOOL_ABORTED)
                error.name = 'AbortError'
                throw error
              }
              return result
            } finally {
              clearTimeout(timer)
              exec.signal?.removeEventListener('abort', onAbort)
            }
          },
          // 终端卡片展示：与官方 tool-bash/pwsh 一致，对话页可点击查看命令。
          presentCall: (args: BashToolArgs) => ({
            card: 'terminal',
            title: args.command,
            description: args.description,
            ...args.workdir !== undefined ? { cwd: args.workdir } : {},
          }),
          presentResult: (args: unknown, result: { content: Array<{ type: string; text?: string }>; isError: boolean }) => {
            const block = result.content.length === 1 ? result.content[0] : undefined
            if (block === undefined || block.type !== 'text' || block.text === undefined) return undefined
            const raw = block.text
            const isBackground = typeof args === 'object' && args !== null && (args as { run_in_background?: unknown }).run_in_background === true
            if (isBackground || result.isError) {
              return { card: 'generic', content: [{ type: 'text', text: `\`\`\`console\n${raw.replace(/\n+$/, '')}\n\`\`\`` }] }
            }
            const { body, ...exit } = parseExitStatus(raw)
            return { card: 'terminal', output: body, ...exit }
          },
        }))
        registerError = undefined
        ctx.logger.info('[shell-policy] bash 工具已注册（%s）', probe.path)
      } catch (error) {
        bashDisposer = undefined
        effective = 'pwsh'
        registerError = String(error)
        ctx.logger.warn('[shell-policy] bash 工具注册失败，回落 pwsh: %s', registerError)
      }
    } else {
      bashDisposer?.()
      bashDisposer = undefined
      registerError = undefined
      ctx.logger.info('[shell-policy] 生效 shell: pwsh')
    }

    // 注册/注销 bash 工具会改变"该隐藏谁"，活着的 agent 必须重算一次：否则会出现
    // "bash 已注销、pwsh 还被 deny"——模型手里一个 shell 都不剩。上面提前 return
    // 的分支说明 effective 没变，新 agent 由 agent/created 负责，因此不必重扫。
    // 注意用 ctx.get('agents') 而不是 ctx.agents：本插件的 entry 没有声明 `inject`
    // （agents 不是必需依赖），cordis 对未 inject 的服务属性访问会直接抛
    // "cannot get property \"agents\" without inject"。ctx.get() 是允许的探测式读取，
    // 服务不存在时返回 undefined（与上面的 sandbox / sandboxPolicy 同一写法）。
    const agents = ctx.get('agents') as { list(): Agent[] } | undefined
    for (const agent of agents?.list() ?? []) syncAgent(agent)
  }

  // 状态与配置 API（所有平台注册；非 Windows 返回 supported: false）。
  // settings 的 client 端 RPC 有 allowlist 限制（apiproxy WEB_SETTINGS_NAMESPACES），
  // 本插件 namespace 不在其中，因此卡片读写都走本 API：host 端直接经 settings 服务持久化。
  // 注意本路由是裸 webServer 前缀路由，不在 client-connection 的 token/cookie
  // 鉴权伞下（其准入只覆盖 connection 自己注册的路由），故在 handler 入口自行做
  // 回环来源准入（isLocalGuiRequest）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-shell-policy/api',
    handler: async (req: any, res: any) => {
      const url = String(req.url ?? '')
      const send = (code: number, body: unknown): void => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify(body))
      }
      // 准入：仅本机 GUI 自身来源（回环 Origin/Host）可读写，挡住跨站页面
      // 与外部进程的未授权访问。
      if (!isLocalGuiRequest(req)) {
        send(403, { ok: false, error: 'forbidden: only the local GUI origin may call this API' })
        return
      }
      if (url.endsWith('/status') && req.method === 'GET') {
        // 本路由是裸 webServer 路由，请求不带 session 身份，拿不到当前 GUI 会话的
        // 沙箱模式；报组合默认模式供卡片参考，真实判定发生在 per-agent 的
        // tools.restrict（syncAgent）与 execute 两处。
        const defaultMode = (ctx.get('sandboxPolicy') as SandboxPolicyService | undefined)?.resolve({}).mode
        send(200, {
          platform: process.platform,
          supported: isWindows,
          bashFound: probe.found,
          bashPath: probe.path,
          effective,
          preferred: readConfig(source()).preferred,
          configuredBashPath: readConfig(source()).bashPath,
          registerError,
          sandboxModeDefault: defaultMode,
          bashStartableInDefaultMode: bashViableInMode(defaultMode),
        })
        return
      }
      if (url.endsWith('/preferred') && req.method === 'POST') {
        const raw = await new Promise<string>((resolve, reject) => {
          let data = ''
          req.on('data', (chunk: any) => { data += chunk })
          req.on('end', () => resolve(data))
          req.on('error', reject)
        })
        let parsed: { preferred?: unknown }
        try {
          parsed = JSON.parse(raw) as { preferred?: unknown }
        } catch {
          send(400, { ok: false, error: 'invalid json body' })
          return
        }
        const preferred = parsed.preferred
        if (preferred !== 'auto' && preferred !== 'bash' && preferred !== 'pwsh') {
          send(400, { ok: false, error: 'preferred must be auto | bash | pwsh' })
          return
        }
        const settings = ctx.get('settings')
        const entryId = resolveOwnEntryId(ctx)
        if (settings === undefined || entryId === undefined) {
          send(500, { ok: false, error: settings === undefined ? 'settings service unavailable' : 'own profile entry not found' })
          return
        }
        try {
          await settings.mutate(entryId, [{ op: 'set', path: ['preferred'], value: preferred }])
          send(200, { ok: true, preferred, effective })
        } catch (error) {
          send(500, { ok: false, error: String(error) })
        }
        return
      }
      if (url.endsWith('/bashpath') && req.method === 'POST') {
        const raw = await new Promise<string>((resolve, reject) => {
          let data = ''
          req.on('data', (chunk: any) => { data += chunk })
          req.on('end', () => resolve(data))
          req.on('error', reject)
        })
        let parsed: { bashPath?: unknown }
        try {
          parsed = JSON.parse(raw) as { bashPath?: unknown }
        } catch {
          send(400, { ok: false, error: 'invalid json body' })
          return
        }
        const bashPath = typeof parsed.bashPath === 'string' ? parsed.bashPath.trim() : ''
        const settings = ctx.get('settings')
        const entryId = resolveOwnEntryId(ctx)
        if (settings === undefined || entryId === undefined) {
          send(500, { ok: false, error: settings === undefined ? 'settings service unavailable' : 'own profile entry not found' })
          return
        }
        try {
          await settings.mutate(entryId, [{ op: 'set', path: ['bashPath'], value: bashPath }])
          send(200, { ok: true, bashPath, effective })
        } catch (error) {
          send(500, { ok: false, error: String(error) })
        }
        return
      }
      send(404, { ok: false, error: 'not found' })
    },
  }), 'dsh-windows-shell-policy: status api')

  // 非 Windows：DSH 默认 bash 工具已可用，本插件跳过（不注册工具、不过滤、不注册引导）。
  if (!isWindows) {
    ctx.logger.info('[shell-policy] 非 Windows 平台，插件跳过（DSH 默认 bash 工具已可用）')
    return
  }

  // DSH 0.2.0：settings 改为从插件 Config schema 自动投影表单，插件侧不再注册
  // namespace（installSettingsSection / installSection 均已移除）。配置来源即本插件的
  // entry config（apply 收到的 config）；配置变更由 Loader 重建 entry 后重新 apply。
  // 显式声明自动生成表单，并吞掉旧版本无此方法时的错误（策略生效不依赖它）。
  const settings = ctx.get('settings') as { configure?(presentation: { auto?: boolean }): () => void } | undefined
  if (settings !== undefined && typeof settings.configure === 'function') {
    try {
      ctx.effect(() => (settings.configure as (p: { auto?: boolean }) => () => void)({ auto: true }), 'dsh-windows-shell-policy: settings form')
    } catch (error) {
      ctx.logger.warn('[shell-policy] settings.configure 不可用（忽略）: %s', String(error))
    }
  }

  // 应用策略（bash 工具注册 / 注销）。
  applyPolicy()

  // live 更新：volatile 字段（bashPath/preferred）变更时 Loader 只做引用就地
  // 提交并发 loader/volatile-update 事件，不重建 entry、不重新 apply（见
  // cordis-plugin-loader entry.ts _commitVolatile），因此必须在此监听并重算
  // 探测与工具注册，否则卡片保存后 probe/effective 停留在 apply 时刻的旧值。
  ctx.on('loader/volatile-update', () => { applyPolicy() })
  ctx.on('loader/volatile-update', () => { applyPolicy() })

  // 工具面同步的触发点。restrict 只能在 agent 作用域调用，所以按 agent 逐个同步：
  // - created：新建 / resume / clear / 压缩都会走，且是 serial 监听器——在该 agent
  //   释放排队工作之前执行，首轮请求一定已经带上 restriction；
  // - status→running：waking delivery 里同步进入 running，早于本 step 的 tools.resolve；
  // - inbox/inserted：每次提交前重算，权限预设热切换后下一轮即生效（同轮实测正确）；
  // - disposed：撤掉 restriction（agent 作用域随即 unwind）。
  // created 是 serial 事件（listener 可返回 Promise<undefined>），这里同步完就返回。
  ctx.on('agent/created', ({ agent }) => { syncAgent(agent); return undefined })
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'running') syncAgent(agent) })
  ctx.on('agent/inbox/inserted', ({ agent }) => { syncAgent(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const cur = hides.get(agent)
    hides.delete(agent)
    try {
      cur?.dispose()
    } catch {
      // 作用域已 unwind 时 disposer 可能已失效；restriction 本身随 agent 一起回收。
    }
  })

  // 引导文本里"bash 是默认 shell"的判定，与 syncAgent 用的是同一个纯函数。
  const bashUsableIn = (scope: unknown): boolean =>
    desiredHide(effective, sessionSandboxMode(ctx, scope)) === 'pwsh'

  // 引导文本：text 用函数形式，每次 assemble 求值；框架会过滤空文本
  // section，因此 effective=pwsh（含 bash 工具注册失败回落 pwsh）以及 confined
  // 会话自动回落时，不再注入“bash 是默认 shell”，避免与模型实际看到的工具面
  // 自相矛盾。
  ctx.systemPrompt.section({
    name: 'shell-policy',
    order: 104,
    text: (context) => (bashUsableIn(context.scope)
      ? 'Windows shell policy: the `bash` tool (git-bash) is the default shell. '
        + 'Check the [exit code: N] marker on every bash result; investigate failures before moving on.'
      : ''),
  })

  // 卸载清理：注销动态注册的 bash 工具。
  ctx.effect(() => () => {
    bashDisposer?.()
    bashDisposer = undefined
  }, 'dsh-windows-shell-policy: bash tool cleanup')
}

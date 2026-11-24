/**
 * bash 进程终态的纯映射（可单测）。
 *
 * 为什么单独成文件：作业结算状态（completed / killed）和取消原因文案，是模型
 * 判断「命令跑完了」还是「被杀掉了」的唯一依据。官方 `dsh-tool-bash` 对被杀
 * 进程报 `killed`；本插件此前一律报 `completed`，模型 `job_kill` 后台作业后
 * 会看到「completed」，与事实相反。把它抽成纯函数，语义可被测试钉住。
 */
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import type { SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'

/**
 * 把一个已落定的 bash 进程映射成作业终态。
 *
 * @param outcome - 进程的退出结果（exitCode / signal）。
 * @param stopped - 是否由取消路径（job_kill、调用方 abort、teardown）终止。
 * @returns `killed`（带信号名或缺省原因，注册表会再拼上 kill reason），否则
 *   `completed`（带 exit code）。
 */
export function bashJobOutcome(outcome: SubprocessOutcome, stopped: boolean): JobOutcome {
  if (stopped) {
    return {
      status: 'killed',
      detail: outcome.signal !== null ? `signal: ${outcome.signal}` : 'killed before exit',
    }
  }
  return { status: 'completed', detail: `exit code: ${outcome.exitCode ?? 'unknown'}` }
}

/**
 * 取消路径的一句终止说明，拼进 AbortError 的 message：让调用方（以及会话轨迹）
 * 不必再从一次「tool call aborted」去猜命令到底停没停。
 *
 * @param outcome - 已落定的进程结果；进程尚未启动时为 undefined。
 * @returns 可直接接在 `tool call aborted; ` 之后的英文短句。
 */
export function stoppedDetail(outcome: SubprocessOutcome | undefined): string {
  if (outcome === undefined) return 'command was not started'
  return outcome.signal !== null
    ? `command was killed by signal ${outcome.signal}`
    : `command exited (exit code ${outcome.exitCode ?? 'unknown'})`
}

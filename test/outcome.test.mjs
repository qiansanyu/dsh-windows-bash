/**
 * bash 进程终态映射的单元测试（node:test，跑编译产物）。
 *
 * 这两条映射决定模型看到的后台作业是 completed 还是 killed、取消时命令到底
 * 停没停：官方 dsh-tool-bash 对被杀进程报 killed，本插件此前一律报
 * completed，模型 job_kill 后会看到与事实相反的「completed」。语义钉在这里，
 * 以后换 jobs/subprocess 载体时先红再改。
 *
 * 跑法：npm run build:tsc && npm test
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { bashJobOutcome, stoppedDetail } from '../lib/outcome.js'

test('bashJobOutcome: 取消路径报 killed，正常退出报 completed', () => {
  assert.deepEqual(bashJobOutcome({ exitCode: 1, signal: null }, true), {
    status: 'killed',
    detail: 'killed before exit',
  })
  assert.deepEqual(bashJobOutcome({ exitCode: null, signal: 'SIGKILL' }, true), {
    status: 'killed',
    detail: 'signal: SIGKILL',
  })
  assert.deepEqual(bashJobOutcome({ exitCode: 0, signal: null }, false), {
    status: 'completed',
    detail: 'exit code: 0',
  })
  assert.deepEqual(bashJobOutcome({ exitCode: 3, signal: null }, false), {
    status: 'completed',
    detail: 'exit code: 3',
  })
})

test('stoppedDetail: 带上终止结果，进程未启动时明确说明', () => {
  assert.equal(stoppedDetail(undefined), 'command was not started')
  assert.equal(stoppedDetail({ exitCode: null, signal: 'SIGKILL' }), 'command was killed by signal SIGKILL')
  assert.equal(stoppedDetail({ exitCode: 1, signal: null }), 'command exited (exit code 1)')
})

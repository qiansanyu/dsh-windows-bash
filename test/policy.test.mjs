/**
 * `desiredHide` 的单元测试（node:test，跑编译产物）。
 *
 * 这条判定是"模型手里始终有且只有一个能跑的 shell"的唯一出处：
 * 它以前埋在 `system-prompt/assemble` 的 waterfall 里，0.2.2 换了载荷形状后
 * 载体变成 per-agent `tools.restrict` —— 判定本身必须被钉住，否则以后换机制
 * 会悄悄改变语义。
 *
 * 跑法：npm run build:tsc && npm test
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { bashViableInMode, desiredHide } from '../lib/policy.js'

test('bashViableInMode: 只有 danger-full-access（或无 sandboxPolicy）能启动 MSYS', () => {
  assert.equal(bashViableInMode(undefined), true)
  assert.equal(bashViableInMode('danger-full-access'), true)
  assert.equal(bashViableInMode('workspace-write'), false)
  assert.equal(bashViableInMode('read-only'), false)
})

test('effective=bash + 全权限：隐藏 pwsh', () => {
  assert.equal(desiredHide('bash', 'danger-full-access'), 'pwsh')
})

test('effective=bash + confined：隐藏 bash，回落 pwsh', () => {
  assert.equal(desiredHide('bash', 'workspace-write'), 'bash')
  assert.equal(desiredHide('bash', 'read-only'), 'bash')
})

test('effective=bash + 无 sandboxPolicy：按可用处理，隐藏 pwsh', () => {
  assert.equal(desiredHide('bash', undefined), 'pwsh')
})

test('effective=pwsh：什么都不隐藏（bash 工具没注册，deny 会抛 unknown name）', () => {
  assert.equal(desiredHide('pwsh', 'danger-full-access'), undefined)
  assert.equal(desiredHide('pwsh', 'workspace-write'), undefined)
  assert.equal(desiredHide('pwsh', undefined), undefined)
})

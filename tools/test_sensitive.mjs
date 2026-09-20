/**
 * Sensitive-boundary regression tests.
 *
 * Two rules that are easy to get wrong and expensive to get wrong:
 *  1. FLAGGING a stored entry (so it never auto-injects) must use the HARD
 *     patterns only — flagging on word-level patterns (`password` / `api_key`)
 *     would silently drop ordinary technical notes out of recall.
 *  2. EGRESS control (what may be sent to the decision model) stays
 *     conservative: a word mention is enough to skip the call.
 */
import assert from 'node:assert/strict'
import { loadPlugin } from './load-plugin.mjs'

const plugin = await loadPlugin()

// --- 1) hard vs word-level patterns -----------------------------------------
assert.equal(plugin.containsHardSecret('联系我 13812345678'), true, 'CN mobile is a hard secret')
assert.equal(plugin.containsHardSecret('token: sk-abcdefghijkl'), true, 'sk- value is a hard secret')
assert.equal(plugin.containsHardSecret('把 api_key 放进环境变量，不要写进配置'), false,
  'a WORD mention must not flag an entry')
assert.equal(plugin.containsSensitive('把 api_key 放进环境变量，不要写进配置'), true,
  'egress control stays conservative on word mentions')

// --- 2) normalizeEntry back-fills the flag on imported entries ---------------
assert.equal(
  plugin.normalizeEntry({ id: 'MEM-T-1', title: '联系人', content: '手机 13900000000' }).sensitive,
  true,
  'imported entry holding a real number gets flagged',
)
assert.equal(
  plugin.normalizeEntry({ id: 'MEM-T-2', title: '构建', content: '用 esbuild 打包；key 走环境变量' }).sensitive,
  false,
  'ordinary technical note stays injectable',
)

// --- 3) an explicit decision is never overridden -----------------------------
assert.equal(plugin.normalizeEntry({ id: 'MEM-T-3', title: 'x', content: '普通内容', sensitive: true }).sensitive, true)
assert.equal(plugin.normalizeEntry({ id: 'MEM-T-4', title: 'y', content: '手机 13800000000', sensitive: false }).sensitive, false,
  'a human-cleared flag stays cleared')

// --- 4) the flag does not leak into the rendered block -----------------------
const block = plugin.renderInjectionBlock([
  { id: 'MEM-T-5', title: '普通记忆', category: 'fact', jev_prob: 0.9, content: '正文' },
])
assert.ok(block.includes('<retrieved-memories count="1" judged-by="jev">'))
assert.ok(block.includes('MEM-T-5'))

console.log('test_sensitive_ok')
process.exit(0)

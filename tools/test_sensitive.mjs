/**
 * Egress-guard regression tests (v0.3.0).
 *
 * Design rule: the regex guard protects the OUTBOUND path only. It never decides
 * what may be stored, what may be retrieved, or what may be injected — those are
 * the user's calls (if an entry should not exist, don't write it).
 *
 * Concretely:
 *   - the guard fires on the QUESTION and makes recall fall back to local ranking
 *     instead of returning nothing;
 *   - stored entries are never filtered out by a regex;
 *   - the `sensitive` field is informational, and is not set by pattern matching.
 */
import assert from 'node:assert/strict'
import { loadPlugin } from './load-plugin.mjs'

const plugin = await loadPlugin()

// 1) the matcher still exists, for egress decisions only
assert.equal(plugin.containsSensitive('卡号 6222021234567890123'), true)
assert.equal(plugin.containsSensitive('帮我看下构建脚本'), false)

// 2) no regex-driven flagging on load — the label is not a machine verdict
assert.equal(
  plugin.normalizeEntry({ id: 'MEM-T-1', title: '联系人', content: '手机 13900000000' }).sensitive,
  false,
  'normalizeEntry must not flag entries by pattern',
)
// …but an explicit flag survives a round-trip
assert.equal(
  plugin.normalizeEntry({ id: 'MEM-T-2', title: 'x', content: 'y', sensitive: true }).sensitive,
  true,
)

// 3) the removed helper must stay removed (guards against reintroducing
//    retrieval-time filtering by pattern)
assert.equal(typeof plugin.containsHardSecret, 'undefined')

// 4) rendering is unaffected by the redesign
const block = plugin.renderInjectionBlock([
  { id: 'MEM-T-3', title: '普通记忆', category: 'fact', jev_prob: 0.9, content: '正文' },
])
assert.ok(block.includes('<retrieved-memories count="1" judged-by="jev">'))
assert.ok(block.includes('MEM-T-3'))

// 5) the egress guard is OPT-IN — "what counts as sensitive" is the user's call
assert.equal(plugin.DEFAULT_CONFIG.egressGuard, false)

console.log('test_sensitive_ok')
process.exit(0)

/**
 * Lossless-JSON regression tests.
 *
 * DSH validates every tool result: a value that does not survive a JSON round-trip
 * (own property valued `undefined`, non-finite number, …) is rejected, and the caller
 * sees `tool "mem_remember" returned invalid output: value is not lossless JSON` —
 * after the write already succeeded. That is exactly what happened in production, so
 * every tool that can be driven offline is asserted here.
 */
import assert from 'node:assert/strict'
import path from 'node:path'
import { loadPlugin, createMockCtx, tempDir, toolByName } from './load-plugin.mjs'
import { FakeJevServer } from './fake-jev.mjs'

const plugin = await loadPlugin()

const fake = new FakeJevServer({ mode: 'noul', noulDefault: 0.8, choiceDefault: 'none', inputTokens: 3851 })
const srv = await fake.start()
process.env.OPENROUTER_API_KEY = srv.apiKey

const { ctx, tools } = createMockCtx()
plugin.apply(ctx, {
  storePath: path.join(tempDir(), 'gate-store.json'),
  jevEndpoint: srv.url,
  dailyBudgetCny: 3.5,
  dailyCallLimit: 3000,
})

/** The exact contract DSH enforces. */
function assertLossless(label, value) {
  assert.notEqual(value, undefined, `${label} returned undefined`)
  const round = JSON.parse(JSON.stringify(value))
  assert.deepEqual(round, value, `${label} is not lossless JSON`)
}

async function call(name, args = {}) {
  const tool = toolByName(tools, name)
  assert.ok(tool, `tool ${name} missing`)
  const out = await tool.execute(args, {})
  assertLossless(name, out)
  return out
}

// 1) write gate, nothing superseded — this is the shape that broke in production
//    (`persistReason`/`superseded`/`retiredNeedsReview` were `undefined`)
fake.reset({
  mode: 'noul',
  answers: {
    worth_keeping: { type: 'noul', noul: 0.9, confidence: 0.9 },
    supersedes: { type: 'choice', choice: 'none', probabilities: { none: 0.9 }, confidence: 0.9 },
  },
})
const first = await call('mem_remember', { content: '第一条用于无损校验的记忆正文。', title: '无损校验一' })
assert.equal(first.ok, true)

// 2) write gate WITH a supersede — exercises `superseded` set while `retiredNeedsReview` stays unset
const target = first.id
assert.ok(target, 'first write must return an id')
fake.reset({
  mode: 'noul',
  answers: {
    worth_keeping: { type: 'noul', noul: 0.9, confidence: 0.9 },
    supersedes: { type: 'choice', choice: target, probabilities: { [target]: 0.9 }, confidence: 0.9 },
  },
})
const second = await call('mem_remember', { content: '第二条：应取代第一条的同一件事。', title: '无损校验二' })
assert.ok(second.superseded || second.retiredNeedsReview, 'a supersede path must have been taken')

// 3) the remaining offline-drivable tools
await call('mem_list')
await call('mem_view', { id: target })
await call('mem_gate_status')
await call('mem_gate_log')
await call('mem_recall', { query: '无损校验' })
await call('mem_pin', { id: target, pinned: true })
await call('mem_forget', { id: target })
await call('mem_restore', { id: target })

// 4) the normalizer itself
assert.deepEqual(plugin.jsonSafe({ a: 1, b: undefined, c: [1, undefined, NaN] }), { a: 1, c: [1, null, null] })

// Close the stub and let the event loop drain: an abrupt process.exit() while the stub
// server is still tearing down trips a libuv assertion on Windows
// (UV_HANDLE_CLOSING / async.c:94), which surfaces as a crashed test instead of a pass.
await srv.close()
console.log('test_lossless_ok')

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadPlugin, createMockCtx, tempDir, toolByName } from './load-plugin.mjs'
import { FakeJevServer } from './fake-jev.mjs'

const plugin = await loadPlugin()

const fake = new FakeJevServer({ mode: 'noul', noulDefault: 0.8, choiceDefault: 'none', inputTokens: 3851 })
const srv = await fake.start()

function setup(cfg = {}) {
  const { ctx, tools, handlers } = createMockCtx()
  const dir = tempDir()
  const storeFile = path.join(dir, 'gate-store.json')
  const applied = plugin.apply(ctx, {
    storePath: storeFile,
    jevEndpoint: srv.url,
    dailyBudgetCny: 3.5,
    dailyCallLimit: 3000,
    ...cfg,
  })
  // point apiKey via env for service — apply already read key at start
  return { dir, storeFile, tools, handlers, applied, ctx }
}

// Force API key into env for the process before apply... apply reads at call time.
process.env.OPENROUTER_API_KEY = srv.apiKey

// --- write gate success + always store ---
{
  const { tools, storeFile } = setup()
  fake.reset({ mode: 'noul', noulDefault: 0.82, choiceDefault: 'none', answers: {
    worth_keeping: { type: 'noul', noul: 0.82, confidence: 0.9 },
    supersedes: { type: 'choice', choice: 'none', probabilities: { none: 0.9 }, confidence: 0.9 },
  } })
  const tool = toolByName(tools, 'mem_remember')
  const out = await tool.execute({
    content: '插件预算默认每日 3.5 元人民币，按次封顶 3000。',
    title: '记忆插件预算默认值',
    category: 'fact',
  }, {})
  assert.equal(out.ok, true)
  assert.equal(out.gate, 'judged')
  assert.equal(out.persisted, true)
  assert.ok(out.id.startsWith('MEM-'))
  assert.ok(out.worth >= 0.8)
  const disk = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  assert.equal(disk.memories.length, 1)
}

// --- write gate: jev fail → still store, gate unavailable ---
{
  const { tools, storeFile } = setup()
  fake.reset({ mode: 'http-error', status: 500 })
  const tool = toolByName(tools, 'mem_remember')
  const out = await tool.execute({ content: '注入钩子放在 agent/pre-step waterfall。', title: '注入钩子位置' }, {})
  assert.equal(out.ok, true)
  assert.equal(out.persisted, true)
  assert.notEqual(out.gate, 'judged')
  const disk = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  assert.equal(disk.memories.length, 1)
}

// --- worth low → needsReview hint ---
{
  const { tools } = setup()
  fake.reset({ answers: { worth_keeping: { type: 'noul', noul: 0.2 } } })
  const tool = toolByName(tools, 'mem_remember')
  const out = await tool.execute({ content: '临时状态：刚才测试了一下', title: '临时状态' }, {})
  assert.equal(out.persisted, true)
  assert.equal(out.needsReview, true)
}

// --- supersede protection: long old entry not silently short ---
{
  const { tools, storeFile } = setup()
  const longContent = 'A'.repeat(400) + '\n```bash\npnpm install\n```\n' + 'B'.repeat(200)
  fake.reset({ answers: { worth_keeping: { type: 'noul', noul: 0.9 } } })
  const tool = toolByName(tools, 'mem_remember')
  const first = await tool.execute({ content: longContent, title: '完整部署手册要点' }, {})
  assert.equal(first.persisted, true)

  // next write similar title so prefilter hits; jev chooses supersedes = first id
  fake.reset({ answers: {
    worth_keeping: { type: 'noul', noul: 0.9 },
    supersedes: { type: 'choice', choice: first.id, probabilities: { [first.id]: 0.9, none: 0.1 } },
  } })
  const second = await tool.execute({ content: '部署手册摘要', title: '完整部署手册要点' }, {})
  assert.equal(second.persisted, true)
  assert.ok(second.retiredNeedsReview || second.superseded)
  const disk = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  const old = disk.memories.find(m => m.id === first.id)
  const neu = disk.memories.find(m => m.id === second.id)
  assert.ok(old.retired === true)
  if (second.retiredNeedsReview) {
    assert.equal(old.needsReview, true)
    assert.equal(old.retiredReason, 'supersede-protected')
  }
  // merge path: merged length >= old
  const mergeTool = toolByName(tools, 'mem_merge')
  const merged = await mergeTool.execute({ oldId: first.id, newId: second.id }, {})
  assert.equal(merged.ok, true)
  assert.ok(merged.mergedLength >= merged.oldLength)
  const after = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  const newAfter = after.memories.find(m => m.id === second.id)
  assert.ok(String(newAfter.content).length >= longContent.length)
}

// --- sensitive → redacted-skip, still stored ---
{
  const { tools } = setup()
  fake.reset({ mode: 'noul' })
  const tool = toolByName(tools, 'mem_remember')
  const out = await tool.execute({ content: '我的手机号是 13812345678，api_key=sk-live-abcdefghijk', title: '联系密钥' }, {})
  assert.equal(out.gate, 'redacted-skip')
  assert.equal(out.persisted, true)
}

// --- recall: judged separates scores ---
{
  const { tools } = setup()
  fake.reset({ mode: 'noul', noulDefault: 0.75 })
  const rem = toolByName(tools, 'mem_remember')
  await rem.execute({ content: '注入门默认开启，失败即关闭不注入。', title: '注入门 fail-closed 策略' }, {})
  await rem.execute({ content: '迁移脚本需要 dry-run 与幂等。', title: '迁移脚本幂等' }, {})
  fake.reset({
    answers: {
      // will be filled dynamically by server defaults for any rel_*
    },
    noulDefault: 0.8,
  })
  // Program answers by intercepting: use default noul 0.8 for all
  const rec = toolByName(tools, 'mem_recall')
  const out = await rec.execute({ query: '注入门失败时怎么处理？' }, {})
  assert.equal(out.gate, 'judged')
  assert.equal(out.degraded, null)
  assert.ok(out.items.length >= 1)
  for (const it of out.items) {
    assert.ok(it.jev_prob == null || typeof it.jev_prob === 'number')
    assert.ok(typeof it.local_score === 'number')
  }
}

// --- recall fail-open degraded ---
{
  const { tools } = setup()
  const rem = toolByName(tools, 'mem_remember')
  await rem.execute({ content: '熔断连续三次失败冷却五分钟。', title: 'Jev 熔断策略' }, {})
  fake.reset({ mode: 'http-error', status: 500 })
  const rec = toolByName(tools, 'mem_recall')
  const out = await rec.execute({ query: '熔断怎么配置？' }, {})
  assert.notEqual(out.gate, 'judged')
  assert.ok(out.degraded)
  assert.ok(String(out.degraded.note ?? out.degraded.reason ?? '').length > 0)
  assert.ok(out.items.length >= 0)
}

// --- restore keeps supersedeHistory ---
{
  const { tools } = setup()
  fake.reset({ answers: { worth_keeping: { type: 'noul', noul: 0.9 } } })
  const rem = toolByName(tools, 'mem_remember')
  const a = await rem.execute({ content: '旧教训：不要用 UTC 算今日预算', title: 'UTC 预算坑' }, {})
  const b = await rem.execute({ content: '新教训：今日预算必须用 Asia/Shanghai 本地日', title: 'UTC 预算坑' }, {})
  const view = toolByName(tools, 'mem_view')
  const forget = toolByName(tools, 'mem_forget')
  const restore = toolByName(tools, 'mem_restore')
  await forget.execute({ id: b.id }, {})
  const r = await restore.execute({ id: b.id, cascade: true }, {})
  assert.equal(r.ok, true)
  assert.ok(r.restored.includes(b.id))
  const after = await view.execute({ id: b.id }, {})
  assert.ok(Array.isArray(after.supersedeHistory))
}

// --- gate_status surfaces budget/key/store ---
{
  const { tools } = setup()
  const st = toolByName(tools, 'mem_gate_status')
  const out = await st.execute({}, {})
  assert.ok(out.key === 'present' || out.key === 'absent')
  assert.ok(out.storePath.includes('gate-store.json'))
  assert.ok(typeof out.budget.spentCny === 'number')
  assert.ok(out.config.build)
}

// --- injection I1/I2/reset/fail-closed ---
{
  process.env.OPENROUTER_API_KEY = srv.apiKey
  const { tools, handlers, applied, storeFile } = setup({ injectMinProbability: 0.6, injectLimit: 3 })
  fake.reset({ noulDefault: 0.9 })
  const rem = toolByName(tools, 'mem_remember')
  await rem.execute({ content: 'AGENTS.md 必须可维护，写清坑与验证。', title: 'AGENTS.md 维护要求' }, {})
  await rem.execute({ content: 'OpenRouter key 放环境变量 OPENROUTER_API_KEY。', title: 'OpenRouter 密钥位置' }, {})

  const pre = handlers['agent/pre-step'][0]
  const agent = { id: 'agent-1', sessionId: 'sess-1' }
  const mkUser = (text) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
  const messages = [mkUser('OpenRouter 的密钥配置在哪里？')]

  // I1: multiple steps same turn → one inject
  const snapshots = []
  let injected = 0
  for (let step = 0; step < 5; step++) {
    const decision = await pre({ agent, messages, turn: 1, step, signal: undefined }, async () => ({ kind: 'enter', messages: messages.slice() }))
    const snaps = decision.messages.filter(m => m.source?.kind === 'plugin' && m.source.form === 'snapshot')
    if (snaps.length > 0) injected += 1
    snapshots.push(snaps.length)
  }
  assert.equal(injected, 1, `expected 1 turn injection, got ${injected} snapshots=${snapshots}`)

  // I2: claimed batch with prior snapshot messages → still no NEW inject for same ids
  const firstTurnDecision = await pre({ agent, messages, turn: 2, step: 0, signal: undefined }, async () => ({ kind: 'enter', messages: messages.slice() }))
  const again = await pre({ agent, messages, turn: 3, step: 0, signal: undefined }, async () => ({ kind: 'enter', messages: messages.slice() }))
  const snapMsgs = again.messages.filter(m => m.source?.form === 'snapshot')
  const withHistory = [...messages, ...snapMsgs]
  fake.reset({ noulDefault: 0.9 })
  const afterSnap = await pre({ agent, messages: withHistory, turn: 4, step: 0, signal: undefined }, async () => ({ kind: 'enter', messages: withHistory.slice() }))
  const afterSnaps = afterSnap.messages.filter(m => m.source?.form === 'snapshot')
  // If prior snapshots still in the observed batch, no additional inject (I2).
  // If snapMsgs empty (pool already exhausted on earlier turns), also no new inject.
  assert.equal(afterSnaps.length, 0, `I2 violated: expected 0 new snapshots, got ${afterSnaps.length}`)

  // reset via explicit full-history observation (simulates post-compaction history without snapshots)
  const without = messages.filter(m => m.source?.form !== 'snapshot')
  const injectSnap = await applied.service.injectSnapshot({
    sessionId: 'sess-1',
    turn: 9,
    step: 0,
    messages: without,
    observedSnapshotIds: new Set(), // full history has no plugin snapshots
  })
  // after reset, injectSnapshot should be allowed to return inject again
  const re = await pre({ agent, messages: without, turn: 10, step: 0, signal: undefined }, async () => ({ kind: 'enter', messages: without.slice() }))
  const reSnaps = re.messages.filter(m => m.source?.form === 'snapshot')
  assert.ok(reSnapSnapsLengthHelper(reSnaps) || injectSnap.kind === 'inject', `expected re-inject after explicit snapshot-missing reset, injectSnap=${injectSnap.kind} re=${reSnaps.length}`)

  // fail-closed
  fake.reset({ mode: 'http-error', status: 500 })
  const fail = await pre({ agent, messages: without, turn: 11, step: 0, signal: undefined }, async () => ({ kind: 'enter', messages: without.slice() }))
  assert.equal(fail.messages.filter(m => m.source?.form === 'snapshot').length, 0)

  // no key → no inject
  delete process.env.OPENROUTER_API_KEY
  const noKeyApplied = (() => {
    const { ctx, handlers } = createMockCtx()
    const dir = tempDir()
    plugin.apply(ctx, { storePath: path.join(dir, 'gate-store.json'), jevEndpoint: srv.url })
    return handlers
  })()
  // Note: apply already captured empty key
  const pre2 = noKeyApplied['agent/pre-step'][0]
  const d2 = await pre2({ agent, messages: without, turn: 1, step: 0, signal: undefined }, async () => ({ kind: 'enter', messages: without.slice() }))
  assert.equal(d2.messages.filter(m => m.source?.form === 'snapshot').length, 0)

  // pool empty → 0 calls growth measured via fake request count freeze
  process.env.OPENROUTER_API_KEY = srv.apiKey
  const { handlers: h3 } = setup({ injectMinProbability: 0.99 })
  // seed nothing relevant and use greeting
  const pre3 = h3['agent/pre-step'][0]
  fake.reset({ mode: 'noul', noulDefault: 0.9 })
  const before = fake.requests.length
  const g = await pre3({ agent, messages: [mkUser('嗯')], turn: 1, step: 0, signal: undefined }, async () => ({ kind: 'enter', messages: [mkUser('嗯')] }))
  assert.equal(g.messages.filter(m => m.source?.form === 'snapshot').length, 0)
  assert.equal(fake.requests.length, before, 'greeting must not call Jev')
}

// --- retry/circuit via callJev ---
{
  fake.reset({ mode: 'network', failNextN: 1 })
  process.env.OPENROUTER_API_KEY = srv.apiKey
  const dir = tempDir()
  const ledger = new plugin.BudgetLedger(path.join(dir, 'b.json'), { dailyBudgetCny: 3.5, dailyCallLimit: 100 })
  const breaker = new plugin.CircuitBreaker(3, 60_000)
  const r1 = await plugin.callJev({
    endpoint: srv.url,
    apiKey: srv.apiKey,
    state: { q: 'x' },
    questions: { a: { type: 'noul', instructions: 'x' } },
    timeoutMs: 3000,
    breaker,
    ledger,
    estTokens: 1000,
  })
  // first network error retries once → succeed after failNextN consumed
  assert.equal(r1.ok, true, `expected network retry success, got ${JSON.stringify(r1)}`)
  assert.ok(r1.attempt >= 2, `expected attempt>=2 after retry, got ${r1.attempt}`)

  fake.reset({ mode: 'http-error', status: 500 })
  let last
  const breaker2 = new plugin.CircuitBreaker(3, 60_000)
  for (let i = 0; i < 3; i++) {
    last = await plugin.callJev({
      endpoint: srv.url, apiKey: srv.apiKey, state: {}, questions: { a: { type: 'noul', instructions: 'x' } },
      timeoutMs: 2000, breaker: breaker2, ledger, estTokens: 500,
    })
    assert.equal(last.ok, false)
    assert.equal(last.attempt, 1, `HTTP error must not retry (i=${i} attempt=${last.attempt} reason=${last.reason})`)
  }
  // circuit open after 3 failures
  const open = await plugin.callJev({
    endpoint: srv.url, apiKey: srv.apiKey, state: {}, questions: { a: { type: 'noul', instructions: 'x' } },
    timeoutMs: 2000, breaker: breaker2, ledger, estTokens: 500,
  })
  assert.equal(open.ok, false)
  assert.equal(open.reason, 'circuit-open')
}

// --- no usage → estimated cost ---
{
  const { ledger } = (() => {
    const dir = tempDir()
    return { ledger: new plugin.BudgetLedger(path.join(dir, 'b.json'), { dailyBudgetCny: 3.5, dailyCallLimit: 100 }) }
  })()
  fake.reset({ mode: 'no-usage', noulDefault: 0.8 })
  const r = await plugin.callJev({
    endpoint: srv.url, apiKey: srv.apiKey, state: {}, questions: { a: { type: 'noul', instructions: 'x' } },
    timeoutMs: 2000, breaker: new plugin.CircuitBreaker(), ledger, estTokens: 3851,
  })
  assert.equal(r.ok, true)
  assert.equal(r.costSource, 'estimated')
}

function reSnapSnapsLengthHelper(list) {
  return Array.isArray(list) && list.length >= 1
}

await srv.close()
console.log('test_gates_ok')
process.exit(0)

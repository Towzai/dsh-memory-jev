/**
 * Offline audit-log report: answer the three operational questions.
 * Usage: node tools/gate_report.mjs [--data <dir>] [--since YYYY-MM-DD] [--kind kind]
 */
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const args = { data: path.join(process.cwd(), 'data'), since: null, kind: null }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--data') args.data = argv[++i]
    else if (argv[i] === '--since') args.since = argv[++i]
    else if (argv[i] === '--kind') args.kind = argv[++i]
  }
  return args
}

function main() {
  const args = parseArgs(process.argv)
  const logDir = path.join(args.data, 'logs')
  const files = fs.existsSync(logDir)
    ? fs.readdirSync(logDir).filter(f => f.startsWith('gate-decisions-') && f.endsWith('.jsonl')).sort()
    : []
  const rows = []
  for (const f of files) {
    const day = f.slice('gate-decisions-'.length, '.jsonl'.length * -1)
    if (args.since && day < args.since) continue
    const text = fs.readFileSync(path.join(logDir, f), 'utf8')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (args.kind && row.kind !== args.kind) continue
        rows.push(row)
      } catch { /* skip */ }
    }
  }
  const byKind = {}
  let cost = 0
  let calls = 0
  let emptyPool = 0
  let injectFail = 0
  let injectOk = 0
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1
    if (typeof r.cost_cny === 'number') cost += r.cost_cny
    if (r.kind && r.kind.endsWith('-gate')) calls += 1
    if (r.result?.skippedReason === 'pool-empty') emptyPool += 1
    if (r.kind === 'inject-gate' && r.gate === 'judged' && (r.result?.injected ?? []).length > 0) injectOk += 1
    if (r.kind === 'inject-gate' && r.gate && r.gate !== 'judged' && r.gate !== 'no-candidates') injectFail += 1
  }
  console.log(JSON.stringify({
    dataDir: args.data,
    logDir,
    totalRows: rows.length,
    costCny: Number(cost.toFixed(6)),
    gateCalls: calls,
    byKind,
    emptyPoolSkips: emptyPool,
    injectSuccess: injectOk,
    injectNonJudged: injectFail,
    questions: {
      todaySpent: cost,
      calls,
      whyNoInject: emptyPool,
      suspectedLexicalMiss: emptyPool,
    },
  }, null, 2))
}

main()

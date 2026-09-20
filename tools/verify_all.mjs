/**
 * Aggregate verification entry. Runs every tools/test_*.mjs once with the
 * peer-package resolve shim. Exits non-zero if any test fails.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const files = fs.readdirSync(here).filter(f => f.startsWith('test_') && f.endsWith('.mjs')).sort()
const loader = pathToFileURL(path.join(here, 'load-plugin.mjs')).href

const results = []
let failed = 0
for (const f of files) {
  const file = path.join(here, f)
  process.stdout.write(`→ ${f} `)
  const r = spawnSync(process.execPath, ['--import', loader, file], {
    stdio: 'inherit',
    env: process.env,
  })
  const code = r.status ?? 1
  results.push({ file: f, code, ok: code === 0 })
  if (code === 0) {
    console.log('PASS')
  } else {
    console.log(`FAIL (exit ${code})`)
    failed += 1
  }
}

console.log('\n=== verify_all summary ===')
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file}`)
}
console.log(`total=${results.length} failed=${failed}`)
process.exit(failed > 0 ? 1 : 0)

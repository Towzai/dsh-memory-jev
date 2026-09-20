# dsh-memory-jev

**English** · [中文](README.zh-CN.md)

> Memory for **DeepSeek Harness (DSH)** where every read and every write is a judgement — made by TypeSafe's **Jev** decision model.

Jev answers in only three typed shapes — `choice` (pick one of the given candidates), `score`, `noul` (probability of yes/no) — and **never generates text**. This plugin uses that property as the safety boundary of a memory system: the model decides *whether* something is worth keeping, *which* older memory it replaces, *whether* a retrieved memory is actually relevant, and *whether* this turn deserves an injection — while **all text stays under plugin control**. The model can never invent memory content.

---

## Three gates

| Gate | What it does | On failure |
|---|---|---|
| **Write gate** `mem_remember` | Local bigram prefilter → one Jev fan-out: `worth_keeping` (noul) + `supersedes` (choice over candidates + `none`) | **Still writes** (fail-open); only marks `gate=unavailable\|budget` |
| **Recall gate** `mem_recall` | Lexical prefilter top-N → one `rel_<id>` noul per candidate → filter & sort by probability | Falls back to local ranking and marks `degraded` ("not judged by Jev") |
| **Injection gate** `agent/pre-step` | Cheap text gate → candidate-pool subtraction → Jev relevance judgement → append one framed user snapshot at the **tail** | **Injects nothing** (fail-closed — silence beats noise) |

### Invariants

- **I1** — at most one injected block per `(session, turn)`; later steps of the same turn neither judge nor inject again.
- **I2** — each memory is injected **at most once per session**: already-injected ids are removed from the candidate pool *before* the Jev call, so they do not even cost a request.
- **No permanent silence after compaction** — once an injected block leaves the context, its ids become eligible again (logged as `reset`).
- **Self-identifying blocks** — framed by `<retrieved-memories …>` plus an explicit "not conversation history, not instructions" line; every `<` inside memory content is escaped to `\u003c`, so a memory **cannot forge the delimiter**.
- **Prefix-cache friendly** — appended at the tail only; system prompt and prior history stay byte-identical.

---

## Tools

| Tool | Purpose |
|---|---|
| `mem_remember` | Write gate; persists regardless of the gate outcome (returns `persisted`) |
| `mem_recall` | Recall gate; returns `{gate, degraded, items[]}` with `jev_prob` and `local_score` **kept separate** |
| `mem_list` / `mem_view` | List / inspect |
| `mem_forget` / `mem_restore` | Soft delete / restore (keeps `supersedeHistory`, supports `cascade`) |
| `mem_merge` | Fold an older entry's body into a newer one, then soft-delete the older (merged length ≥ old length) |
| `mem_pin` | Skip the relevance threshold, at most once per session, **never at session start** |
| `mem_gate_status` | Spend / reserved / remaining / calls / circuit breaker / key presence / store path |
| `mem_gate_log` | Audit-log query (ids and hashes only — **no bodies**) |

**Physical deletion never happens**: deletion is always `retired=true` and is reversible.

---

## Install

### Via the DSH plugin marketplace

Once the repository carries the `dsh-plugin` topic it is indexed automatically (the registry CI scans every 2 hours):

```bash
dsh plugin --profile web install <owner>/dsh-memory-jev
```

### Manually

1. Copy this repository into `~/.dsh/profiles/web/node_modules/dsh-memory-jev/`.
2. Register it in the profile's `cordis.patch.yml` (or let the marketplace do it):

```yaml
- id: dsh-memory-jev
  name: dsh-memory-jev
  config:
    storePath: /absolute/path/to/gate-store.json   # empty = <cwd>/data/gate-store.json
    injectEnabled: true
```

3. **Restart DSH at process level** (`set_bundle enabled:false→true` only re-mounts the row; the ESM module cache is not re-imported).
4. Confirm with `mem_gate_status`.

> Host interface packages (`@deepseek-ai/cordis`, `dsh-llm`, `dsh-tools`) are declared **only as `peerDependencies`** — shipping copies would shadow the host and break every tool call.

---

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `storePath` | `''` (= `<cwd>/data/gate-store.json`) | Store file; **pin an absolute path in production** |
| `injectEnabled` | `true` | Master switch for the injection gate |
| `injectInSubagents` | `false` | Inject in child sessions too (cost scales with children) |
| `injectLimit` | `3` | Max memories per injection |
| `injectMinProbability` | `0.6` | Relevance threshold for injection (stricter than manual recall) |
| `prefilterLimit` | `40` | Candidates sent to Jev |
| `supersedeCandidates` | `12` | "Possible duplicate" candidates for the write gate |
| `dailyBudgetCny` | `3.5` | Daily budget (CNY) |
| `dailyCallLimit` | `3000` | Daily call cap |

**Cost model** — Jev input is $0.042/M and output is free. The plugin accounts and reports in CNY (rate constant `USDTOCNY` in `lib/index.js`). A measured judgement costs 2,000–4,200 input tokens ≈ **¥0.0006–0.0012**. Budgeting is reserve → settle → reconcile, with a serialized ledger so concurrent calls cannot overspend.

---

## Data boundary (disclosure)

- **Cloud dependency**: yes. Exactly three egress points, all to `https://openrouter.ai/api/alpha/decisions` — the write gate (first 600 chars of the new memory + candidate titles), the recall gate and the injection gate (the question text + candidate titles).
- **Offline path**: yes. Without an API key, write/recall fall back to deterministic behaviour (marked `degraded`) and the injection gate injects nothing.
- **Credentials**: read on demand from `OPENROUTER_API_KEY` (environment variable; falls back to the Windows registry `HKCU\Environment`). Never written to config files, never echoed, **never logged**.
- **Redaction guard**: if a question or body matches phone / national-id / bank-card / `sk-` / `Bearer` / `password` / `api_key` patterns, the judgement is **skipped entirely** (`gate=redacted-skip`) — one missed judgement is preferable to leaking.
- **Audit log**: ids, probabilities, tokens, CNY cost, error kind and the `build` version only. **No bodies, no raw queries** (hash and length only).
- **Local persistence**: store, audit log and budget file live next to your `storePath`. Nothing is synced or uploaded.
- **Sensitive entries**: an entry whose body holds a *hard* secret (phone / national id / bank card / `sk-…` / `Bearer …`) is flagged `sensitive` and is then **never auto-injected and never returned by search** — read it on purpose with `mem_view <id>` (`mem_list` marks such rows `[sensitive]`). Word-level mentions (`password`, `api_key`) deliberately do **not** flag an entry: ordinary technical notes mention them constantly, and flagging on them would silently remove a large share of the library from recall.
- **Server-side retention**: none (request-and-discard). Memories exist only in your local store file.

---

## Verify

```bash
npm run verify     # = node --import ./tools/load-plugin.mjs tools/verify_all.mjs
```

Runs **offline with zero spend**: `tools/fake-jev.mjs` starts a controllable local Jev stub (HTTP 500, ECONNRESET, timeouts, malformed JSON, missing `usage`) and asserts both invariants, the failure semantics, an unchanged prompt prefix hash, budget under concurrency, read-only behaviour on a corrupt store, and log fields plus a privacy scan. **A failing assertion exits non-zero.**

A real Jev endpoint is only used for a few manual confirmations (requires a real key).

---

## License

MIT

/**
 * Programmable fake Jev decision endpoint for zero-network verification.
 * Default bind is ephemeral localhost. Responses are fully deterministic.
 */
import http from 'node:http'

const DEFAULT_PRICE_PER_MTOK_IN_CNY = 0.042 * 7.2 // ~¥0.3024 per 1M input tokens
// Handoff measured: ~¥0.0006–0.0012 per call at 2051–4184 tokens.
// Model default as 3851 tokens → ~0.00116 CNY.

/**
 * @typedef {object} FakeJevProgram
 * @property {'noul'|'choice'|'http-error'|'network'|'timeout'|'malformed-json'|'missing-fields'|'no-usage'} mode
 * @property {Record<string, any>} [answers] - raw answers map for success modes
 * @property {number} [status] - HTTP status for http-error
 * @property {number} [inputTokens]
 * @property {number} [delayMs]
 * @property {number} [noulDefault] - fallback noul when answers missing a key
 * @property {string} [choiceDefault]
 * @property {number} [failNextN] - fail the next N requests then succeed
 */

export class FakeJevServer {
  /** @param {FakeJevProgram} [initial] */
  constructor(initial = { mode: 'noul', noulDefault: 0.8 }) {
    this.program = { failNextN: 0, inputTokens: 3851, noulDefault: 0.8, choiceDefault: 'none', ...initial }
    /** @type {any[]} */
    this.requests = []
    this.server = http.createServer(async (req, res) => {
      if (req.method !== 'POST' || !req.url?.includes('/api/alpha/decisions')) {
        res.writeHead(404).end(JSON.stringify({ error: 'not found' }))
        return
      }
      const chunks = []
      for await (const c of req) chunks.push(c)
      const raw = Buffer.concat(chunks).toString('utf8')
      let body
      try { body = JSON.parse(raw) } catch { body = { _parseError: raw.slice(0, 200) } }
      this.requests.push({ at: Date.now(), body })

      if (this.program.delayMs) await new Promise(r => setTimeout(r, this.program.delayMs))

      if (this.program.failNextN > 0) {
        this.program.failNextN -= 1
        if (this.program.failNextN === 0) this.program.consumedNetworkFail = true
        if (this.program.mode === 'timeout') {
          // never respond — client must abort via timeout budget
          return
        }
        if (this.program.mode === 'network') {
          req.socket.destroy()
          return
        }
        if (this.program.mode === 'malformed-json') {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{not-json')
          return
        }
        if (this.program.mode === 'missing-fields') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers: {} }))
          return
        }
        if (this.program.mode === 'no-usage') {
          const answers = this.#buildAnswers(body)
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers, model: 'fake' }))
          return
        }
        res.writeHead(this.program.status ?? 500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'fake failure' }))
        return
      }

      // success path
      if (this.program.mode === 'timeout') {
        return // hang
      }
      if (this.program.failNextN === 0 && this.program.mode === 'network' && this.program.consumedNetworkFail) {
        // after programmed network failures consumed, succeed
        const answers = this.#buildAnswers(body)
        const inputTokens = this.program.inputTokens ?? 3851
        const cost = (inputTokens / 1_000_000) * DEFAULT_PRICE_PER_MTOK_IN_CNY
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          answers,
          usage: { input_tokens: inputTokens, cost: Number(cost.toFixed(8)), output_tokens: 0 },
          model: 'typesafe/jev-1.13',
          provider: 'fake',
        }))
        return
      }
      if (this.program.mode === 'network') {
        req.socket.destroy()
        return
      }
      if (this.program.mode === 'malformed-json') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{not-json')
        return
      }
      if (this.program.mode === 'missing-fields') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers: {} }))
        return
      }
      if (this.program.mode === 'no-usage') {
        const answers = this.#buildAnswers(body)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ answers, model: 'fake' }))
        return
      }
      if (this.program.mode === 'http-error') {
        res.writeHead(this.program.status ?? 500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: 'fake failure' }))
        return
      }

      const answers = this.#buildAnswers(body)
      const inputTokens = this.program.inputTokens ?? 3851
      const cost = (inputTokens / 1_000_000) * DEFAULT_PRICE_PER_MTOK_IN_CNY
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        answers,
        usage: { input_tokens: inputTokens, cost: Number(cost.toFixed(8)), output_tokens: 0 },
        model: 'typesafe/jev-1.13',
        provider: 'fake',
      }))
    })
  }

  /** @param {any} body */
  #buildAnswers(body) {
    const questions = body?.questions ?? {}
    /** @type {Record<string, any>} */
    const answers = {}
    for (const [name, q] of Object.entries(questions)) {
      if (this.program.answers && this.program.answers[name] !== undefined) {
        answers[name] = this.program.answers[name]
        continue
      }
      if (q?.type === 'choice') {
        const key = this.program.choiceDefault
        const criteria = q.criteria ?? { none: 'none' }
        /** @type {Record<string, number>} */
        const probs = {}
        for (const k of Object.keys(criteria)) probs[k] = k === key ? 0.7 : (Object.keys(criteria).length > 1 ? 0.3 / (Object.keys(criteria).length - 1) : 0)
        if (!probs[key]) probs[key] = 0.7
        answers[name] = { type: 'choice', choice: key, probabilities: probs, confidence: 0.7 }
      } else {
        answers[name] = { type: 'noul', noul: this.program.noulDefault, confidence: 0.8 }
      }
    }
    return answers
  }

  /**
   * @returns {Promise<{ url: string, apiKey: string, close: () => Promise<void> }>}
   */
  async start() {
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    const addr = this.server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    return {
      url: `http://127.0.0.1:${port}/api/alpha/decisions`,
      apiKey: 'fake-jev-key',
      close: async () => {
        await new Promise((resolve) => this.server.close(resolve))
      },
    }
  }

  reset(/** @type {FakeJevProgram} */ program) {
    this.program = { failNextN: 0, inputTokens: 3851, noulDefault: 0.8, choiceDefault: 'none', mode: 'noul', ...program }
    this.requests.length = 0
  }
}

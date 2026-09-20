/**
 * Node resolve hook: map @deepseek-ai/* peer packages to local shims when
 * loading plugin code outside a DSH host.
 */
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const toolsDir = path.dirname(fileURLToPath(import.meta.url))

const MAP = {
  '@deepseek-ai/dsh-tools': pathToFileURL(path.join(toolsDir, 'shim-dsh-tools.mjs')).href,
  '@deepseek-ai/dsh-llm': pathToFileURL(path.join(toolsDir, 'shim-dsh-llm.mjs')).href,
}

export async function resolve(specifier, context, nextResolve) {
  if (MAP[specifier]) {
    return { url: MAP[specifier], shortCircuit: true }
  }
  return nextResolve(specifier, context)
}

/**
 * Minimal Cordis-like host mock + plugin loader for out-of-band verification.
 */
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
register('./shim-hooks.mjs', pathToFileURL(path.join(here, 'shim-register-base')))

export async function loadPlugin() {
  return import(pathToFileURL(path.join(here, '..', 'lib', 'index.js')).href)
}

/**
 * @returns {{ ctx: any, tools: any[], handlers: Record<string, Function[]> }}
 */
export function createMockCtx() {
  /** @type {any[]} */
  const tools = []
  /** @type {Record<string, Function[]>} */
  const handlers = {}
  const ctx = {
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {
          const i = tools.indexOf(tool)
          if (i >= 0) tools.splice(i, 1)
        }
      },
    },
    on(event, handler) {
      const list = handlers[event] ?? (handlers[event] = [])
      list.push(handler)
      return () => {
        const i = list.indexOf(handler)
        if (i >= 0) list.splice(i, 1)
      }
    },
    effect(fn) {
      return fn()
    },
  }
  return { ctx, tools, handlers }
}

/** Isolated temp workspace for store/log/budget files. */
export function tempDir(prefix = 'memjev-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/**
 * Find a registered tool by name.
 * @param {any[]} tools
 * @param {string} name
 */
export function toolByName(tools, name) {
  return tools.find(t => t.name === name)
}

/** Recursively assert every object node has additionalProperties boolean. */
export function walkSchemaObjectNodes(parameters, pathLabel = 'parameters', violations = []) {
  if (!parameters || typeof parameters !== 'object') return violations
  for (const [key, node] of Object.entries(parameters)) {
    if (!node || typeof node !== 'object') continue
    const p = `${pathLabel}.${key}`
    if (node.type === 'object') {
      if (typeof node.additionalProperties !== 'boolean') {
        violations.push(`${p}: object missing additionalProperties`)
      }
      if (node.properties) walkSchemaObjectNodes(node.properties, `${p}.properties`, violations)
    }
    if (node.type === 'array' && node.items) {
      walkSchemaObjectNodes({ items: node.items }, p, violations)
      if (node.items.type === 'object') {
        if (typeof node.items.additionalProperties !== 'boolean') {
          violations.push(`${p}.items: object missing additionalProperties`)
        }
        if (node.items.properties) walkSchemaObjectNodes(node.items.properties, `${p}.items.properties`, violations)
      }
    }
  }
  return violations
}

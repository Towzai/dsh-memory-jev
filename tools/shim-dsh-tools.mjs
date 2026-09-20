/**
 * Out-of-band shim for @deepseek-ai/dsh-tools — used only when running
 * plugin code outside a live DSH host (verification scripts).
 */
export function defineTool(def) {
  return def
}

/**
 * Out-of-band shim for @deepseek-ai/dsh-llm createUserMessage.
 */
export function createUserMessage(input) {
  return {
    id: input.id ?? `msg-${Math.random().toString(36).slice(2, 10)}`,
    role: 'user',
    content: input.content,
    source: input.source,
  }
}

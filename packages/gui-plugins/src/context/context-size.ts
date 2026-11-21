import type { SessionMessageInfo } from "@opencode/client/promise"
import { lastAssistantWithUsage } from "@opencode/client/solid"
import { messageTokens } from "./breakdown"

/** The model a measured step ran on, so the caller can divide by that model's window. */
export type ContextModel = { id: string; providerID: string }

/**
 * What fills the context window right now.
 *
 * A measured step (the latest assistant usage after the last completed compaction and before an
 * undo boundary) is the truth. Between a completed compaction and the next assistant step there is
 * no such step, so the window is estimated from the messages the compaction kept: the summary plus
 * everything after it. That estimate is what the next request will send, so the header shows the
 * reduced size instead of dropping to zero.
 */
export type ContextSize =
  | { readonly total: number; readonly measured: true; readonly model: ContextModel }
  | { readonly total: number; readonly measured: false }

export function contextSize(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string): ContextSize | undefined {
  const assistant = lastAssistantWithUsage(messages, boundary)
  if (assistant) {
    return {
      total:
        assistant.tokens.input +
        assistant.tokens.output +
        assistant.tokens.reasoning +
        assistant.tokens.cache.read +
        assistant.tokens.cache.write,
      measured: true,
      model: assistant.model,
    }
  }

  // Mirror the boundary rule in `lastAssistantWithUsage`: a boundary that names a missing message
  // makes the window unknowable, rather than measuring the wrong span.
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  if (boundary && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex

  const compactionIndex = messages.findLastIndex(
    (message, index) => message.type === "compaction" && message.status === "completed" && index < end,
  )
  if (compactionIndex === -1) return undefined

  const total = messages
    .slice(compactionIndex, end)
    .reduce((sum, message) => sum + messageTokens(message), 0)

  return { total, measured: false }
}

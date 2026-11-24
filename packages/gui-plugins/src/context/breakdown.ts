import type { SessionMessageInfo } from "@opencode/client/promise"

/**
 * Where a slice of the context window came from. Each message contributes to one
 * or more sources, so the panel can say what is filling the window, not only how
 * full it is.
 */
export type ContextSource =
  /** System prompts, injected instructions, loaded skills and compaction summaries. */
  | "system"
  /** The user's own prompt text. */
  | "user"
  /** Files attached to a prompt. */
  | "media"
  /** Assistant text. */
  | "assistant"
  /** Assistant reasoning, replayed into later steps. */
  | "reasoning"
  /** Tool inputs. */
  | "calls"
  /** Tool results streamed back into the window. */
  | "results"
  /** Shell output the model sees. */
  | "shell"

/** One source's share of the context window. */
export type Bucket = {
  source: ContextSource
  tokens: number
  /** Messages that contribute, in transcript order, for the click-through list. */
  messages: string[]
}

/** The whole window's split, plus the estimate it totals to. */
export type Breakdown = {
  buckets: Bucket[]
  /** Sum of every bucket. An estimate, never a provider measurement. */
  estimated: number
}

/** One message's contribution to one source. */
export type Contribution = { source: ContextSource; tokens: number }

/** One message's share of one source, for the list a section row expands into. */
export type BucketItem = {
  id: string
  type: SessionMessageInfo["type"]
  tokens: number
}

/**
 * Character-derived token estimate. Mirrors `CHARS_PER_TOKEN` in
 * `packages/core/src/util/token.ts`: a GUI plugin may not import Core (client
 * runtime depends on Schema and Protocol only), so the constant is repeated
 * here instead of shared.
 */
const CHARS_PER_TOKEN = 4

/** Mirrors `IMAGE_TOKEN_ESTIMATE` and `PDF_TOKEN_ESTIMATE` in core's compaction. */
const IMAGE_TOKENS = 1_500

const PDF_TOKENS = 2_000

/** A file whose bytes the client does not hold; only its presence is known. */
const FILE_TOKENS = 500

/** Approximate a string's cost. Never negative, so a bucket can never subtract. */
export function estimate(text: string) {
  return Math.max(0, Math.round(text.length / CHARS_PER_TOKEN))
}

/** What one message put in the window, by source. */
export function contributions(message: SessionMessageInfo): Contribution[] {
  if (message.type === "system" || message.type === "synthetic" || message.type === "skill")
    return [{ source: "system", tokens: estimate(message.text) }]

  if (message.type === "compaction" && "summary" in message)
    return [{ source: "system", tokens: estimate(message.summary) }]

  if (message.type === "user")
    return [
      { source: "user", tokens: estimate(message.text) },
      ...(message.files ?? []).map((file) => ({ source: "media" as const, tokens: attachment(file) })),
    ]

  if (message.type === "shell")
    return [{ source: "shell", tokens: estimate(message.command) + estimate(shellOutput(message.output)) }]

  if (message.type !== "assistant") return []

  return message.content.flatMap((part): Contribution[] => {
    if (part.type === "text") return [{ source: "assistant" as const, tokens: estimate(part.text) }]

    if (part.type === "reasoning") return [{ source: "reasoning" as const, tokens: estimate(part.text) }]

    const state = part.state
    const call = { source: "calls" as const, tokens: estimate(JSON.stringify(state.input) ?? "") }

    if (state.status === "completed")
      return [call, ...state.content.map((item) => ({ source: "results" as const, tokens: content(item) }))]

    if (state.status === "error")
      return [
        call,
        { source: "results" as const, tokens: estimate(state.error.message) },
        ...(state.content ?? []).map((item) => ({ source: "results" as const, tokens: content(item) })),
      ]

    return [call]
  })
}

/** One message's total estimate, for its row in the raw-message list. */
export function messageTokens(message: SessionMessageInfo) {
  return contributions(message).reduce((sum, contribution) => sum + contribution.tokens, 0)
}

/** Split the window by source, largest first. Sources no message touched are absent. */
export function breakdown(messages: readonly SessionMessageInfo[]): Breakdown {
  const totals = new Map<ContextSource, { tokens: number; messages: string[] }>()

  for (const message of messages) {
    for (const contribution of contributions(message)) {
      if (contribution.tokens <= 0) continue

      const entry = totals.get(contribution.source) ?? { tokens: 0, messages: [] }
      entry.tokens += contribution.tokens

      if (!entry.messages.includes(message.id)) entry.messages.push(message.id)
      totals.set(contribution.source, entry)
    }
  }

  const buckets = [...totals]
    .map(([source, entry]) => ({ source, tokens: entry.tokens, messages: entry.messages }))
    .sort((left, right) => right.tokens - left.tokens)

  return { buckets, estimated: buckets.reduce((sum, bucket) => sum + bucket.tokens, 0) }
}

/**
 * The items behind every source, in transcript order, each with what it added to that source.
 * Derived from `contributions`, like `breakdown`, so a source's items always add up to the total
 * its section row shows and a section with nothing behind it yields no items.
 */
export function bucketItems(messages: readonly SessionMessageInfo[]): Map<ContextSource, BucketItem[]> {
  const items = new Map<ContextSource, BucketItem[]>()

  for (const message of messages) {
    const perSource = new Map<ContextSource, number>()

    for (const contribution of contributions(message)) {
      if (contribution.tokens <= 0) continue

      perSource.set(contribution.source, (perSource.get(contribution.source) ?? 0) + contribution.tokens)
    }

    for (const [source, tokens] of perSource) {
      const list = items.get(source) ?? []

      list.push({ id: message.id, type: message.type, tokens })
      items.set(source, list)
    }
  }

  return items
}

function attachment(file: NonNullable<Extract<SessionMessageInfo, { type: "user" }>["files"]>[number]) {
  if (file.mime.startsWith("image/")) return IMAGE_TOKENS

  if (file.mime === "application/pdf") return PDF_TOKENS

  // Base64 holds three bytes per four characters; an attachment with no bytes only contributes its name.
  return Math.round((file.data.length * 3) / 4 / CHARS_PER_TOKEN) || estimate(file.name ?? "")
}

function content(item: { type: "text"; text: string } | { type: "file"; mime: string }) {
  if (item.type === "text") return estimate(item.text)

  if (item.mime.startsWith("image/")) return IMAGE_TOKENS

  if (item.mime === "application/pdf") return PDF_TOKENS

  return FILE_TOKENS
}

/** The text of a shell message's captured output; `""` when nothing was captured. */
function shellOutput(output: Extract<SessionMessageInfo, { type: "shell" }>["output"]) {
  return output ? output.output : ""
}

import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { contextSize } from "./context-size"

const assistant = (id: string, input: number, output = 0): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [],
  tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0 },
})

const compaction = (id: string, summary: string): SessionMessageInfo => ({
  id,
  type: "compaction",
  status: "completed",
  reason: "manual",
  summary,
  time: { created: 0 },
})

const user = (id: string, text: string): SessionMessageInfo => ({
  id,
  type: "user",
  text,
  time: { created: 0 },
})

// `estimate` is characters / 4 rounded, so a summary of 40 characters is 10 tokens.
const SUMMARY = "x".repeat(40)

describe("contextSize", () => {
  test("reports a measured assistant step and its model", () => {
    const size = contextSize([assistant("msg_a", 30, 10)])
    expect(size).toEqual({ total: 40, measured: true, model: { id: "model", providerID: "provider" } })
  })

  test("estimates the kept context between a completed compaction and the next step", () => {
    // Before the fix this returned undefined, so the header dropped to 0.
    const size = contextSize([assistant("msg_before", 999), compaction("msg_compaction", SUMMARY)])
    expect(size).toEqual({ total: 10, measured: false })
  })

  test("counts messages retained after the compaction", () => {
    const size = contextSize([
      assistant("msg_before", 999),
      compaction("msg_compaction", SUMMARY),
      user("msg_user", "y".repeat(20)),
    ])
    expect(size).toEqual({ total: 15, measured: false })
  })

  test("prefers the next assistant step once it reports usage", () => {
    const messages = [assistant("msg_before", 999), compaction("msg_compaction", SUMMARY)]
    expect(contextSize(messages)).toEqual({ total: 10, measured: false })

    messages.push(assistant("msg_after", 5, 0))
    expect(contextSize(messages)).toEqual({ total: 5, measured: true, model: { id: "model", providerID: "provider" } })
  })

  test("is unknowable when the undo boundary names a missing message", () => {
    expect(contextSize([assistant("msg_a", 30)], "msg_missing")).toBeUndefined()
  })

  test("is undefined with neither a measured step nor a compaction", () => {
    expect(contextSize([])).toBeUndefined()
    expect(contextSize([user("msg_user", "hello")])).toBeUndefined()
  })
})

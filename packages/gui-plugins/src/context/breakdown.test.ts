import { describe, expect, test } from "bun:test"
import type {
  SessionMessageAssistant,
  SessionMessageInfo,
  SessionMessageUser,
} from "@opencode/client/promise"
import { breakdown, contributions, estimate, messageTokens } from "./breakdown"

const user = (id: string, text: string): SessionMessageUser => ({ id, type: "user", text, time: { created: 1 } })

const system = (id: string, text: string): SessionMessageInfo => ({ id, type: "system", text, time: { created: 1 } })

const assistant = (id: string, content: SessionMessageAssistant["content"]): SessionMessageAssistant => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content,
  time: { created: 1 },
})

describe("estimate", () => {
  test("counts four characters per token", () => {
    expect(estimate("x".repeat(400))).toBe(100)
    expect(estimate("")).toBe(0)
  })
})

describe("contributions", () => {
  test("system, synthetic, skill and compaction text are all instructions", () => {
    for (const message of [
      system("msg_s", "x".repeat(40)),
      { id: "msg_y", type: "synthetic", text: "x".repeat(40), time: { created: 1 } },
      { id: "msg_k", type: "skill", skill: "s", name: "n", text: "x".repeat(40), time: { created: 1 } },
      { id: "msg_c", type: "compaction", status: "completed", reason: "auto", summary: "x".repeat(40), time: { created: 1 } },
    ] satisfies SessionMessageInfo[]) {
      expect(contributions(message)).toEqual([{ source: "system", tokens: 10 }])
    }
  })

  test("a user prompt and its attachments are separate sources", () => {
    const message: SessionMessageUser = {
      ...user("msg_u", "x".repeat(40)),
      files: [{ data: "", mime: "image/png", source: { type: "inline" } }],
    }

    expect(contributions(message)).toEqual([
      { source: "user", tokens: 10 },
      { source: "media", tokens: 1_500 },
    ])
  })

  test("assistant text, reasoning, tool call and tool result each land in their own source", () => {
    const message = assistant("msg_a", [
      { type: "text", text: "x".repeat(40) },
      { type: "reasoning", text: "x".repeat(80) },
      {
        type: "tool",
        id: "tool_1",
        name: "read",
        state: {
          status: "completed",
          input: { path: "a.ts" },
          content: [{ type: "text", text: "x".repeat(400) }],
        },
        time: { created: 1 },
      },
    ])

    const bySource = Object.fromEntries(
      contributions(message).map((contribution) => [contribution.source, contribution.tokens]),
    )

    expect(bySource.assistant).toBe(10)
    expect(bySource.reasoning).toBe(20)
    expect(bySource.calls).toBeGreaterThan(0)
    expect(bySource.results).toBe(100)
  })

  test("a failing tool contributes its error message", () => {
    const message = assistant("msg_e", [
      {
        type: "tool",
        id: "tool_2",
        name: "shell",
        state: { status: "error", input: {}, error: { type: "tool", message: "x".repeat(40) } },
        time: { created: 1 },
      },
    ])

    expect(contributions(message).map((contribution) => contribution.source)).toEqual(["calls", "results"])
  })
})

describe("breakdown", () => {
  const messages: SessionMessageInfo[] = [
    system("msg_s", "x".repeat(400)),
    user("msg_u", "x".repeat(80)),
    assistant("msg_a", [{ type: "text", text: "x".repeat(200) }]),
  ]

  test("sorts sources largest first and totals them", () => {
    const result = breakdown(messages)

    expect(result.buckets.map((bucket) => bucket.source)).toEqual(["system", "assistant", "user"])
    expect(result.buckets.map((bucket) => bucket.tokens)).toEqual([100, 50, 20])
    expect(result.estimated).toBe(170)
  })

  test("every bucket lists the messages that fed it, so the panel can click through", () => {
    const result = breakdown(messages)

    expect(result.buckets.find((bucket) => bucket.source === "user")?.messages).toEqual(["msg_u"])
    expect(result.buckets.find((bucket) => bucket.source === "system")?.messages).toEqual(["msg_s"])
  })

  test("a message with no context cost contributes nothing", () => {
    const result = breakdown([
      { id: "msg_i", type: "idle", outcome: "succeeded", time: { created: 1 } },
      { id: "msg_w", type: "agent-switched", agent: "plan", time: { created: 1 } },
    ])

    expect(result.buckets).toEqual([])
    expect(result.estimated).toBe(0)
  })

  test("messageTokens matches the sum of that message's contributions", () => {
    expect(messageTokens(messages[2])).toBe(50)
  })
})

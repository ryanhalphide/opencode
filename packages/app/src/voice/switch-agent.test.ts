import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client/promise"
import type { ServerCtx } from "@/runtime/server/runtime"
import { tools as spec } from "./spec"
import { VoiceTools } from "./tools"

const agents = [
  { id: "build", name: "build", mode: "primary", hidden: false },
  { id: "plan", name: "plan", mode: "primary", hidden: false },
  { id: "general", name: "general", mode: "subagent", hidden: true },
]

const session = (id: string, title: string, agent: string) =>
  ({
    id,
    title,
    agent,
    location: { directory: `/home/alex/code/${title.toLowerCase()}` },
    time: { created: 1, updated: 1 },
  }) as SessionInfo

/** A stateful server: switchAgent stores the agent, as the real projector does. */
function setup() {
  const stored = new Map([
    ["ses_here", session("ses_here", "HERE", "build")],
    ["ses_other", session("ses_other", "OTHER", "plan")],
  ])

  const calls: { sessionID: string; agent: string }[] = []

  const ctx = {
    sdk: {
      api: {
        session: {
          get: async (request: { sessionID: string }) => {
            const found = stored.get(request.sessionID)

            if (!found) throw new Error("not found")

            return found
          },
          switchAgent: async (request: { sessionID: string; agent: string }) => {
            const found = stored.get(request.sessionID)

            if (!found) throw new Error("not found")

            calls.push(request)
            stored.set(request.sessionID, { ...found, agent: request.agent })
          },
        },
        // The server lists every agent for the session's directory, hidden subagents included.
        agent: {
          list: async (request: { location?: { directory?: string } }) => ({ data: agents, location: request.location }),
        },
      },
    },
  } as unknown as ServerCtx

  const tools = new VoiceTools(ctx, { open: async () => {}, tabs: () => [] })
  const request = { id: "delegation", sessionID: "ses_here", transcript: ["user: switch to plan"] }
  let count = 0

  const run = async (name: string, args: Record<string, unknown> = {}) =>
    JSON.parse(
      await tools.run(
        { call_id: `call_${count++}`, name, arguments: JSON.stringify(args) },
        request,
        new AbortController().signal,
      ),
    )

  return { calls, stored, run }
}

describe("switch_agent", () => {
  test("is offered to the delegator with a required agent", () => {
    const tool = spec.find((item) => item.name === "switch_agent")

    expect(tool?.parameters.required).toEqual(["agent"])
    expect(tool?.parameters.properties).toHaveProperty("agent")
    expect(tool?.parameters.properties).toHaveProperty("session_id")
  })

  test("switches the viewed session and the session then reports the new agent", async () => {
    const voice = setup()

    expect(await voice.run("switch_agent", { agent: "plan" })).toEqual({ switched_to: "plan", session: "HERE" })
    expect(voice.calls).toEqual([{ sessionID: "ses_here", agent: "plan" }])

    // Read the agent back from the same server the tool wrote to.
    expect(voice.stored.get("ses_here")?.agent).toBe("plan")
  })

  test("switches the session named by session_id, leaving the viewed session alone", async () => {
    const voice = setup()

    expect(await voice.run("switch_agent", { session_id: "ses_other", agent: "build" })).toEqual({
      switched_to: "build",
      session: "OTHER",
    })
    expect(voice.stored.get("ses_other")?.agent).toBe("build")
    expect(voice.stored.get("ses_here")?.agent).toBe("build")
  })

  test("accepts a name in any case", async () => {
    const voice = setup()

    expect(await voice.run("switch_agent", { agent: "PLAN" })).toEqual({ switched_to: "plan", session: "HERE" })
    expect(voice.stored.get("ses_here")?.agent).toBe("plan")
  })

  test("refuses an unknown agent instead of writing it and failing later", async () => {
    const voice = setup()
    const result = await voice.run("switch_agent", { agent: "chef" })

    expect(result.error).toContain("No agent chef")
    expect(result.error).toContain("build, plan")
    expect(voice.calls).toEqual([])
    expect(voice.stored.get("ses_here")?.agent).toBe("build")
  })

  test("requires an agent name", async () => {
    const voice = setup()

    expect((await voice.run("switch_agent", {})).error).toBeDefined()
    expect((await voice.run("switch_agent", { agent: "   " })).error).toBeDefined()
    expect(voice.calls).toEqual([])
    expect(voice.stored.get("ses_here")?.agent).toBe("build")
  })
})

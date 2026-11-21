import { describe, expect, test } from "bun:test"
import type { PermissionRequest, SessionInfo } from "@opencode/client/promise"
import type { ServerCtx } from "@/runtime/server/runtime"
import { tools as spec } from "./spec"
import { VoiceTools } from "./tools"

const session = (id: string, title: string) =>
  ({
    id,
    title,
    location: { directory: `/home/alex/code/${title.toLowerCase()}` },
    time: { created: 1, updated: 1 },
  }) as SessionInfo

const permission = (id: string, sessionID: string, action: string, resources: string[], message?: string) =>
  ({ id, sessionID, action, resources, message }) as PermissionRequest

/** A stateful server: reply consumes the request, as the real projector does. */
function setup(pending: PermissionRequest[] = []) {
  const waiting = new Map<string, PermissionRequest[]>()

  for (const item of pending) waiting.set(item.sessionID, [...(waiting.get(item.sessionID) ?? []), item])

  const sessions = new Map([
    ["ses_here", session("ses_here", "HERE")],
    ["ses_other", session("ses_other", "OTHER")],
  ])

  const replies: { sessionID: string; requestID: string; decision: string }[] = []

  const ctx = {
    sdk: {
      api: {
        session: {
          get: async (request: { sessionID: string }) => {
            const found = sessions.get(request.sessionID)

            if (!found) throw new Error("not found")

            return found
          },
        },
        permission: {
          list: async (request: { sessionID: string }) => waiting.get(request.sessionID) ?? [],
          reply: async (input: { sessionID: string; requestID: string; decision: string }) => {
            replies.push(input)
            waiting.set(
              input.sessionID,
              (waiting.get(input.sessionID) ?? []).filter((item) => item.id !== input.requestID),
            )
          },
        },
      },
    },
  } as unknown as ServerCtx

  const tools = new VoiceTools(ctx, { open: async () => {}, tabs: () => [] })
  const request = { id: "delegation", sessionID: "ses_here", transcript: ["user: approve that"] }
  let count = 0

  const run = async (name: string, args: Record<string, unknown> = {}) =>
    JSON.parse(
      await tools.run(
        { call_id: `call_${count++}`, name, arguments: JSON.stringify(args) },
        request,
        new AbortController().signal,
      ),
    )

  return { waiting, replies, run }
}

describe("permission tools", () => {
  test("are offered to the delegator, with a required decision for answers", () => {
    const list = spec.find((item) => item.name === "list_permissions")
    const answer = spec.find((item) => item.name === "answer_permission")

    expect(list?.parameters.required).toEqual([])
    expect(list?.parameters.properties).toHaveProperty("session_id")

    expect(answer?.parameters.required).toEqual(["decision"])
    expect(answer?.parameters.properties).toHaveProperty("request_id")
    expect(answer?.parameters.properties).toHaveProperty("session_id")
  })

  test("list_permissions reports the viewed session's waiting requests as speakable lines", async () => {
    const voice = setup([
      permission("per_1", "ses_here", "bash", ["rm -rf build"]),
      permission("per_2", "ses_here", "external_directory", ["/tmp/*"], "Write outside the project"),
      permission("per_3", "ses_other", "read", ["/etc/hosts"]),
    ])

    expect(await voice.run("list_permissions")).toEqual({
      session: "HERE",
      pending: [
        { id: "per_1", action: "bash", summary: "rm -rf build" },
        { id: "per_2", action: "external_directory", summary: "Write outside the project; /tmp/*" },
      ],
    })
  })

  test.each([
    { decision: "approve", reply: "once" },
    { decision: "always", reply: "always" },
    { decision: "deny", reply: "reject" },
  ])("answer_permission maps a spoken decision to the protocol reply", async ({ decision, reply }) => {
    const voice = setup([permission("per_1", "ses_here", "bash", ["rm -rf build"])])

    expect(await voice.run("answer_permission", { decision })).toEqual({
      answered: reply,
      action: "bash",
      session: "HERE",
    })
    expect(voice.replies).toEqual([{ sessionID: "ses_here", requestID: "per_1", decision: reply }])
    expect(voice.waiting.get("ses_here")).toEqual([])
  })

  test("answer_permission answers the named request and leaves the others waiting", async () => {
    const voice = setup([
      permission("per_1", "ses_here", "bash", ["rm -rf build"]),
      permission("per_2", "ses_here", "read", ["/etc/hosts"]),
    ])

    expect(await voice.run("answer_permission", { request_id: "per_2", decision: "approve" })).toEqual({
      answered: "once",
      action: "read",
      session: "HERE",
    })
    expect(voice.replies).toEqual([{ sessionID: "ses_here", requestID: "per_2", decision: "once" }])
    expect(voice.waiting.get("ses_here")?.map((item) => item.id)).toEqual(["per_1"])
  })

  const refusals: { pending: PermissionRequest[]; args: Record<string, unknown>; error: string }[] = [
    { pending: [], args: { decision: "approve" }, error: "Nothing is waiting" },
    {
      pending: [
        permission("per_1", "ses_here", "bash", ["rm -rf build"]),
        permission("per_2", "ses_here", "read", ["/etc/hosts"]),
      ],
      args: { decision: "approve" },
      error: "2 permissions are pending",
    },
    {
      pending: [permission("per_1", "ses_here", "bash", ["rm -rf build"])],
      args: { decision: "approve", request_id: "per_missing" },
      error: "No pending permission has that id",
    },
  ]

  test.each(refusals)(
    "answer_permission changes nothing when it cannot resolve exactly one request",
    async ({ pending, args, error }) => {
      const voice = setup(pending)

      expect((await voice.run("answer_permission", args)).error).toContain(error)
      expect(voice.replies).toEqual([])
    },
  )
})

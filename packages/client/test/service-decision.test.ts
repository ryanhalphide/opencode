import { expect, test } from "bun:test"
import { decide, probeResult, type LocalService } from "../src/service-probe"
import { deadPid, freeUrl, livePid, serviceFixture } from "./fixture/service-fixture"

const protocolError =
  "Background service uses an incompatible health protocol. Update this client or explicitly restart the service."

function service(input: Pick<LocalService, "state" | "compatible" | "version">) {
  return {
    info: { url: "http://127.0.0.1:4096", pid: 4242, version: input.version },
    endpoint: { url: "http://127.0.0.1:4096" },
    ...input,
  } satisfies LocalService
}

test("a missing health endpoint fails unless the caller requires a different version", () => {
  const missing = service({ version: "2.0.0", state: "ready", compatible: false })
  expect(decide(missing, {})).toEqual({ _tag: "fail", error: new Error(protocolError) })
  expect(decide(missing, { version: "2.0.0" })).toEqual({ _tag: "fail", error: new Error(protocolError) })
  expect(decide(missing, { version: (version) => version.startsWith("2.") })).toEqual({
    _tag: "fail",
    error: new Error(protocolError),
  })
  expect(decide(missing, { version: "3.0.0" })).toEqual({ _tag: "replace", pty: "handoff" })
  expect(decide(service({ state: "ready", compatible: false }), { version: "3.0.0" })).toEqual({
    _tag: "replace",
    pty: "handoff",
  })
})

test("a compatible service is reused when ready, awaited while starting, and fails when it failed", () => {
  expect(decide(service({ version: "2.0.0", state: "ready", compatible: true }), {})).toEqual({ _tag: "reuse" })
  expect(decide(service({ version: "2.0.0", state: "waiting", compatible: true }), { version: "2.0.0" })).toEqual({
    _tag: "wait",
  })
  expect(decide(service({ version: "2.0.0", state: "failed", compatible: true }), {})).toEqual({
    _tag: "fail",
    error: new Error("Background service failed to start"),
  })
})

test("a version mismatch replaces the service, handing off terminals only when it is ready", () => {
  expect(decide(service({ version: "1.0.0", state: "ready", compatible: true }), { version: "2.0.0" })).toEqual({
    _tag: "replace",
    pty: "handoff",
  })
  expect(decide(service({ version: "1.0.0", state: "waiting", compatible: true }), { version: "2.0.0" })).toEqual({
    _tag: "replace",
    pty: "clear",
  })
  expect(decide(service({ version: "1.0.0", state: "failed", compatible: true }), { version: "2.0.0" })).toEqual({
    _tag: "replace",
    pty: "clear",
  })
})

test("a registration naming a dead process with no listener is stale", async () => {
  const outcome = await probeResult({ url: freeUrl(), pid: await deadPid(), version: "test" }, 100)

  expect(outcome.service).toBeUndefined()
  expect(outcome.timedOut).toBe(false)
  expect(outcome.stale).toBe(true)
})

test("a live pid that refuses the connection is not stale and is left alone", async () => {
  const live = livePid()
  try {
    const outcome = await probeResult({ url: freeUrl(), pid: live.pid, version: "test" }, 100)

    expect(outcome.service).toBeUndefined()
    expect(outcome.timedOut).toBe(false)
    expect(outcome.stale).toBeUndefined()
    expect(() => process.kill(live.pid, 0)).not.toThrow()
  } finally {
    live.kill("SIGKILL")
    await live.exited
  }
})

test("a registration that names a dead process is stale even while another service answers", async () => {
  await using fixture = await serviceFixture()
  fixture.spawn("graceful")
  await fixture.waitForFile()
  const live = await Bun.file(fixture.registration).json()

  const outcome = await probeResult({ ...live, pid: await deadPid() }, 1_000)

  expect(outcome.service).toBeUndefined()
  expect(outcome.stale).toBe(true)
})

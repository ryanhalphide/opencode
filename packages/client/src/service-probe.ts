import { homedir } from "node:os"
import { join } from "node:path"
import type { DiscoverOptions, Endpoint, Info } from "./service.js"
import { defaultEnsureTiming } from "./service-timing.js"
import { matchesVersion } from "./service-version.js"

// Shared by the Effect and Promise clients. Keep this module free of Effect so the
// Promise client never loads the Effect runtime.

export type LocalService = {
  readonly info: Info
  readonly endpoint: Endpoint
  readonly version?: string
  readonly state: "ready" | "waiting" | "failed"
  readonly compatible: boolean
}

/**
 * What `ensure()` does with a registered service that answered: return it, keep polling while
 * it starts, replace it because its version does not meet the requirement, or fail.
 */
export function decide(service: LocalService, options: DiscoverOptions) {
  if (!matchesVersion(service.version, options))
    return { _tag: "replace", pty: service.state === "ready" ? "handoff" : "clear" } as const
  if (!service.compatible)
    return fail(
      "Background service uses an incompatible health protocol. Update this client or explicitly restart the service.",
    )
  if (service.state === "ready") return { _tag: "reuse" } as const
  if (service.state === "failed") return fail("Background service failed to start")
  return { _tag: "wait" } as const
}

function fail(message: string) {
  return { _tag: "fail" as const, error: new Error(message) }
}

/** The default registration file. */
export function fallback() {
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "opencode", "service.json")
}

/** Whether two registrations describe the same service instance. */
export function same(left: Info, right: Info) {
  return left.id === right.id && left.version === right.version && left.url === right.url && left.pid === right.pid
}

/**
 * The outcome of asking a registered owner for its health.
 *
 * `stale` is separate from `timedOut` on purpose: an unreachable owner is not necessarily dead, and
 * an owner that is provably dead must not be waited on. Only `stale` permits immediate recovery.
 */
export type ProbeOutcome = {
  readonly service: LocalService | undefined
  readonly timedOut: boolean
  /** The registration names a process that no longer exists, so it can be cleaned up immediately. */
  readonly stale?: true
}

/**
 * Whether a recorded service process still exists.
 *
 * `kill(pid, 0)` performs the permission check without delivering a signal: ESRCH proves the process
 * is gone, EPERM proves it exists but belongs to another user, and any other error is treated as
 * alive so a registration is never discarded on an inconclusive answer.
 */
export function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return !(cause instanceof Error && "code" in cause && cause.code === "ESRCH")
  }
}

/** `stale` when the recorded process is provably gone, so callers can spread it into a probe outcome. */
function dead(info: Info): Pick<ProbeOutcome, "stale"> {
  return alive(info.pid) ? {} : { stale: true }
}

/** Ask a registered owner for its health and classify the answer. */
export async function probeResult(
  info: Info,
  timeout = defaultEnsureTiming.requestTimeout,
): Promise<ProbeOutcome> {
  const endpoint = {
    url: info.url,
    auth: info.password === undefined ? undefined : { type: "basic", username: "opencode", password: info.password },
  } satisfies Endpoint
  const signal = AbortSignal.timeout(timeout)
  const result = await fetch(new URL("/api/info", info.url), { headers: headers(endpoint), signal })
    .then(async (response) => ({
      response,
      body: response.status === 404 ? undefined : ((await response.json()) as unknown),
    }))
    .catch(() => undefined)
  if (result === undefined) return { service: undefined, timedOut: signal.aborted, ...dead(info) }
  const response = result.response
  // A missing health endpoint identifies protocol incompatibility, not an older
  // version. Only an unmet version requirement lets ensure replace this owner.
  if (response.status === 404)
    return {
      service: {
        info,
        endpoint,
        version: info.version,
        state: "ready",
        compatible: false,
      } satisfies LocalService,
      timedOut: false,
    }
  const serverInfo = decodeInfo(result.body)
  if (serverInfo === undefined) return { service: undefined, timedOut: false }
  // A mismatched answer means the registration no longer describes the owner that replied, so the
  // record is useless either way. Only a provably dead pid may be cleaned up without waiting.
  if (serverInfo.pid !== info.pid) return { service: undefined, timedOut: false, ...dead(info) }
  if (info.version !== undefined && serverInfo.version !== info.version)
    return { service: undefined, timedOut: false, ...dead(info) }
  return {
    service: {
      info,
      endpoint,
      version: serverInfo.version,
      state: response.ok ? "ready" : response.status === 500 ? "failed" : "waiting",
      compatible: true,
    } satisfies LocalService,
    timedOut: false,
  }
}

/** Create HTTP authentication headers for a service endpoint. */
export function headers(endpoint: Endpoint) {
  if (endpoint.auth === undefined) return undefined
  return {
    authorization: "Basic " + Buffer.from(endpoint.auth.username + ":" + endpoint.auth.password).toString("base64"),
  }
}

function decodeInfo(input: unknown) {
  if (typeof input !== "object" || input === null) return
  if (!("version" in input) || typeof input.version !== "string") return
  if (!("pid" in input) || typeof input.pid !== "number" || !Number.isInteger(input.pid) || input.pid < 0) return
  return { version: input.version, pid: input.pid }
}

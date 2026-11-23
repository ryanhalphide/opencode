export function parseCliVersion(output: string) {
  const marker = output.lastIndexOf(" v")
  const version = marker === -1 ? output : output.slice(marker + 2)

  if (!version) throw new Error("V2 CLI did not provide a version")

  return version
}

export function serviceVersion(input: {
  readonly channel: "local" | "dev" | "beta" | "prod"
  readonly isolated?: boolean
  readonly mode: "initial" | "reconnect"
  readonly version: string
}) {
  if (input.mode === "reconnect") return undefined

  if (input.channel === "beta" && !input.isolated) return undefined

  return input.version
}

// Retrying on timeout can also replace a server stuck in a migration longer than 120 s, which is accepted.
export function shouldRetryEnsure(version: string | undefined, message: string) {
  if (version !== undefined) return false

  return (
    message === "Background service failed to start" ||
    message === "Timed out waiting for the background service to start"
  )
}

// Stock channels share one registration file; every other channel gets its own.
const STOCK_CHANNELS = new Set(["latest", "dev", "beta", "next"])

/**
 * The registration file a CLI build writes, resolved the way the CLI resolves it: a stock channel shares
 * `service.json`, and any other channel gets `service-<channel>.json`. The CLI's channel is a compile-time
 * constant, and the version it reports (`<base>-<channel>-<build>`, where base is the release line, or `0.0.0` for
 * builds made before it tracked one) is the only place this process can read it, so a locally built CLI with a
 * custom channel is found by its real name rather than a guessed one.
 */
export function serviceFilename(version: string | undefined) {
  const channel =
    version?.match(/^\d+\.\d+\.\d+-([a-zA-Z0-9._-]+?)-\d+(?:\.\d+)?$/)?.[1] ??
    (version !== undefined && /^[a-zA-Z][a-zA-Z0-9._-]*$/.test(version) ? version : undefined)

  if (channel === undefined || STOCK_CHANNELS.has(channel)) return "service.json"

  return `service-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`
}

export function stageName(version: string, arch = process.arch) {
  return `${version}-${arch}`.replace(/[^a-zA-Z0-9._-]/g, "-")
}

export function keptStages(bundledVersion: string, runningVersion?: string, arch = process.arch) {
  const stages = [stageName(bundledVersion, arch)]

  if (runningVersion && runningVersion !== bundledVersion) stages.push(stageName(runningVersion, arch))

  return stages
}

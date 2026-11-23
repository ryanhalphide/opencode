import { describe, expect, test } from "bun:test"
import path from "node:path"
import semver from "semver"
import { isPreviewVersion, previewVersion } from "../src/version"

describe("preview version", () => {
  test("uses the release line as its base, which clears the API's 1.18.0 minimum", async () => {
    const core = await Bun.file(path.resolve(import.meta.dir, "../../core/package.json")).json()
    const version = previewVersion(core.version, "rh2-opencode-feedback", "202611222045")

    expect(version).toBe(`${core.version}-rh2-opencode-feedback-202611222045`)
    expect(semver.valid(version)).toBe(version)
    expect(semver.gte(version, "1.18.0")).toBe(true)
  })

  test("Script reports a computed preview version, and OPENCODE_VERSION still wins", async () => {
    const script = async (env: Record<string, string>) => {
      const proc = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const { Script } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/index.ts"))}); process.stderr.write(JSON.stringify({ channel: Script.channel, version: Script.version, preview: Script.preview }))`,
        ],
        {
          env: { ...process.env, OPENCODE_CHANNEL: "", OPENCODE_VERSION: "", ...env },
          stdout: "ignore",
          stderr: "pipe",
        },
      )
      const text = await new Response(proc.stderr).text()
      expect(await proc.exited).toBe(0)
      return JSON.parse(text)
    }

    const computed = await script({ OPENCODE_CHANNEL: "rh2-opencode-feedback" })
    expect(computed.preview).toBe(true)
    expect(computed.version).toMatch(/^\d+\.\d+\.\d+-rh2-opencode-feedback-\d+$/)
    expect(semver.gte(computed.version, "1.18.0")).toBe(true)

    expect(await script({ OPENCODE_VERSION: "2.3.2" })).toEqual({ channel: "latest", version: "2.3.2", preview: false })
    const legacy = await script({ OPENCODE_CHANNEL: "beta", OPENCODE_VERSION: "0.0.0-beta-7" })
    expect(legacy).toEqual({ channel: "beta", version: "0.0.0-beta-7", preview: true })
  })

  test.each([
    { version: "2.3.2-rh2-opencode-feedback-202611222045", expected: true },
    { version: "2.3.2-local-1795222193706", expected: true },
    { version: "2.3.2-dev-17403.2", expected: true },
    { version: "0.0.0-dev-17403", expected: true },
    { version: "0.0.0-beta-new", expected: true },
    { version: "2.3.2", expected: false },
    { version: "2.4.0-rc.1", expected: false },
  ])("isPreviewVersion($version) -> $expected", (input) => {
    expect(isPreviewVersion(input.version)).toBe(input.expected)
  })
})

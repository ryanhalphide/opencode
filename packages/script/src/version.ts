// A preview build reports `<base>-<channel>-<build>`, where base is the release line it was cut from. It used to be
// `0.0.0-<channel>-<build>`, but the OpenCode API refuses clients below its minimum version (the free tier needs
// 1.18.0 or newer), so a 0.0.0 build could never reach it. Both shapes are recognised.
const previewPattern = /^\d+\.\d+\.\d+-[a-zA-Z0-9._-]+-\d+(?:\.\d+)?$/

export function previewVersion(base: string, channel: string, build: string) {
  return `${base}-${channel}-${build}`
}

export function isPreviewVersion(version: string) {
  return version.startsWith("0.0.0-") || previewPattern.test(version)
}

import { readFile } from "node:fs/promises"

// A contender that records whether a registration file existed when it started, then fails. A test
// can use it to prove that a stale registration was cleaned before recruitment, not after.
const [registration, output] = process.argv.slice(2)
if (registration === undefined || output === undefined) throw new Error("Missing inspect-registration arguments")
const present = await readFile(registration, "utf8").then(
  () => true,
  () => false,
)
await Bun.write(output, String(present))
process.exit(1)

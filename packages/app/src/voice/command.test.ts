import { describe, expect, test } from "bun:test"
import type { CommandOption } from "@/shell/commands/command"
import { registerVoiceCallCommand, VOICE_CALL_COMMAND_ID, VOICE_COMMAND_KEY } from "./command"

// A stateful fake of the app registry: it stores the options callback the owner registers.
function fakeCommands() {
  const owners = new Map<string, () => CommandOption[]>()

  return {
    register(key: string, options: () => CommandOption[]) {
      owners.set(key, options)
    },
    options(key: string) {
      return owners.get(key)?.() ?? []
    },
  }
}

describe("voice.call command", () => {
  test("registers voice.call and starts a call while one can start", () => {
    const commands = fakeCommands()
    const state = { available: true, started: 0 }

    registerVoiceCallCommand(commands, {
      available: () => state.available,
      title: "Call",
      start: () => {
        state.started += 1
      },
    })

    const options = commands.options(VOICE_COMMAND_KEY)
    expect(options.map((option) => option.id)).toEqual([VOICE_CALL_COMMAND_ID])

    options[0]?.onSelect?.()

    expect(state.started).toBe(1)
  })

  test("is not listed and starts nothing once its gate closes", () => {
    const commands = fakeCommands()
    const state = { available: true, started: 0 }

    registerVoiceCallCommand(commands, {
      available: () => state.available,
      title: "Call",
      start: () => {
        state.started += 1
      },
    })

    const option = commands.options(VOICE_COMMAND_KEY)[0]
    state.available = false

    expect(commands.options(VOICE_COMMAND_KEY)).toEqual([])
    expect(() => option?.onSelect?.()).not.toThrow()
    expect(state.started).toBe(0)
  })
})

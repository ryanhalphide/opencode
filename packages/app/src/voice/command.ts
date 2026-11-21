import type { CommandOption } from "@/shell/commands/command"

export const VOICE_CALL_COMMAND_ID = "voice.call"

/** Registration key the composer owns while its session pane is mounted. */
export const VOICE_COMMAND_KEY = "voice"

/**
 * Registers the call command against the app command registry. The registry evaluates the
 * options callback reactively, so the palette entry follows the composer's gates exactly:
 * it is listed while a call can start and disappears as soon as one cannot.
 */
export function registerVoiceCallCommand(
  command: { register(key: string, options: () => CommandOption[]): void },
  input: VoiceCallCommandInput,
) {
  command.register(VOICE_COMMAND_KEY, () => voiceCallOptions(input))
}

type VoiceCallCommandInput = {
  /** The composer button's own gate: desktop, non-prod channel, experiment on, a session, and a startable call. */
  available: () => boolean
  title: string
  start: () => void
}

export function voiceCallOptions(input: VoiceCallCommandInput): CommandOption[] {
  if (!input.available()) return []

  return [
    {
      id: VOICE_CALL_COMMAND_ID,
      title: input.title,
      // Re-checked on select, so a palette entry that outlived its gate does nothing instead of failing a call.
      onSelect: () => {
        if (!input.available()) return
        input.start()
      },
    },
  ]
}

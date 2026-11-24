import { expect, test, type Page } from "@playwright/test"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { T0, pageMessagesFrom, provider, sessionHref } from "../utils/app"
import { mockWorkspace } from "../utils/workspace"
import { expectSessionTitle } from "../utils/waits"

// The Context pane lists one row per source and expands it into the messages that fed that source.
// This fixture keeps every character count exact so a row's total and its items can be compared.

const limit = 20_000

const model = { providerID: "opencode", id: "test" }

const text = (character: string, length: number) => character.repeat(length)

const messages: SessionMessageInfo[] = [
  // 40,000 characters ⇒ 10,000 tokens.
  { id: "msg_system", type: "system", text: text("s", 40_000), time: { created: T0 } },
  // 2,000 characters ⇒ 500 tokens.
  { id: "msg_user", type: "user", text: text("u", 2_000), time: { created: T0 + 1 } },
  {
    id: "msg_assistant_1",
    type: "assistant",
    agent: "build",
    model,
    // The measured half of the window; `total` is the sum, as core reports it.
    tokens: { input: 15_000, output: 204, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: T0 + 2 },
    content: [
      // 8,000 characters ⇒ 2,000 tokens of assistant text.
      { type: "text", text: text("a", 8_000) },
      // 4,000 characters ⇒ 1,000 tokens of reasoning.
      { type: "reasoning", text: text("r", 4_000) },
      {
        type: "tool",
        id: "tool_1",
        name: "grep",
        time: { created: T0 + 3 },
        state: {
          status: "completed",
          // `{"pattern":"…"}` is 416 characters ⇒ 104 tokens of tool input.
          input: { pattern: text("p", 400) },
          // 6,000 characters ⇒ 1,500 tokens of tool result.
          content: [{ type: "text", text: text("t", 6_000) }],
        },
      },
    ],
  },
  {
    id: "msg_assistant_2",
    type: "assistant",
    agent: "build",
    model,
    time: { created: T0 + 4 },
    // 400 characters ⇒ 100 tokens of assistant text.
    content: [{ type: "text", text: text("b", 400) }],
  },
]

// Largest first, as the panel orders them.
const expected = [
  { source: "system", tokens: 10_000, items: ["msg_system"] },
  { source: "assistant", tokens: 2_100, items: ["msg_assistant_1", "msg_assistant_2"] },
  { source: "results", tokens: 1_500, items: ["msg_assistant_1"] },
  { source: "reasoning", tokens: 1_000, items: ["msg_assistant_1"] },
  { source: "user", tokens: 500, items: ["msg_user"] },
  { source: "calls", tokens: 104, items: ["msg_assistant_1"] },
]

const section = (page: Page, source: string) => page.locator(`[data-slot="context-section"][data-source="${source}"]`)

const row = (page: Page, source: string) => section(page, source).getByRole("button")

const items = (page: Page, source: string) => section(page, source).locator('[data-slot="context-section-items"] > li')

async function openContext(page: Page) {
  await mockWorkspace(page, {
    name: "ContextPane",
    provider: provider({ id: "test", name: "Test", limit: { context: limit } }),
    sessions: [{ id: "ses_context_pane", title: "Context pane" }],
    pageMessages: pageMessagesFrom({ ses_context_pane: messages }),
  })

  await page.goto(sessionHref("ses_context_pane"))
  await expectSessionTitle(page, "Context pane")
  await page.getByRole("button", { name: "Toggle session context" }).click()
  await expect(page.locator('[data-slot="context-breakdown"]')).toBeVisible()
}

test.use({ serviceWorkers: "block" })

test("each section expands into the messages that fed it, and its items add up to its total", async ({ page }) => {
  await openContext(page)

  for (const bucket of expected) {
    const button = row(page, bucket.source)

    await expect(button).toHaveAttribute("aria-expanded", "false")
    // Every listed row has items, so every listed row shows its chevron.
    await expect(button.locator("svg")).toHaveCount(1)
    await expect(items(page, bucket.source)).toHaveCount(0)
  }

  // The row's total is the sum of the items it opens into, for every source.
  for (const bucket of expected) {
    const button = row(page, bucket.source)

    await expect(button).toContainText(bucket.tokens.toLocaleString("en-US"))

    await button.click()
    await expect(button).toHaveAttribute("aria-expanded", "true")
    await expect(items(page, bucket.source)).toHaveCount(bucket.items.length)

    for (const id of bucket.items) await expect(items(page, bucket.source)).toContainText([id])

    await button.click()
    await expect(button).toHaveAttribute("aria-expanded", "false")
    await expect(items(page, bucket.source)).toHaveCount(0)
  }
})

test("a source with nothing behind it has no row, so no row can toggle empty", async ({ page }) => {
  await openContext(page)

  // `shell`, `media` and `compaction` messages are absent from this fixture, and the panel lists no row for them.
  await expect(page.locator('[data-slot="context-section"]')).toHaveCount(expected.length)
  await expect(section(page, "shell")).toHaveCount(0)
  await expect(section(page, "media")).toHaveCount(0)
})

test("an opened section narrows the raw-message list to the same messages", async ({ page }) => {
  await openContext(page)

  const button = row(page, "results")

  await button.click()
  await expect(button).toHaveAttribute("aria-expanded", "true")
  await expect(items(page, "results")).toHaveCount(1)
  await expect(page.getByText("Showing 1 of 4", { exact: false })).toBeVisible()
})

test("screenshots the pane with a section open and closed", async ({ page }) => {
  await openContext(page)

  const panel = page.locator('[data-slot="context-breakdown"]')
  // An element screenshot waits for the panel's open animation to settle, unlike a viewport capture.
  await panel.screenshot({ path: "e2e/screenshots/context-pane-collapsed.png" })

  await row(page, "assistant").click()
  await expect(items(page, "assistant")).toHaveCount(2)
  await panel.screenshot({ path: "e2e/screenshots/context-pane-expanded.png" })

  await row(page, "assistant").click()
  await expect(items(page, "assistant")).toHaveCount(0)
})

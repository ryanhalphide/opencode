import { expect, test } from "bun:test"
import { Usage } from "@opencode/ai/effect"
import { Money } from "@opencode/schema/money"
import { SessionUsage } from "@opencode/core/session/usage"

// $1 per million fresh input tokens, so a million of them price at $1 from the catalog.
const costs = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
  },
]

test("prices the tokens from the catalog when the endpoint reports no cost", () => {
  expect(SessionUsage.record(new Usage({ nonCachedInputTokens: 1_000_000 }), costs).cost).toBe(Money.USD.make(1))
})

test("records the cost the endpoint reports instead of the catalog price", () => {
  expect(SessionUsage.record(new Usage({ nonCachedInputTokens: 1_000_000, cost: 0.25 }), costs).cost).toBe(
    Money.USD.make(0.25),
  )
})

test("keeps a reported zero cost, as for a request a subscription covered", () => {
  expect(SessionUsage.record(new Usage({ nonCachedInputTokens: 1_000_000, cost: 0 }), costs)).toEqual({
    tokens: { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: Money.USD.zero,
  })
})

// DeepSeek-shaped: weekday 01:00-04:00 or 06:00-10:00 UTC, factor 2, not a CN holiday.
const peak = [
  {
    when: {
      utc_days: { in: ["mon", "tue", "wed", "thu", "fri"] },
      any: [
        { all: [{ utc_hours: { gte: "01:00" } }, { utc_hours: { lt: "04:00" } }] },
        { all: [{ utc_hours: { gte: "06:00" } }, { utc_hours: { lt: "10:00" } }] },
      ],
      not: { holiday: { equals: "CN" } },
    },
    factor: 2,
  },
]
const million = { input: 1_000_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

test("applies the catalog time multiplier during its window", () => {
  // 2026-11-23 is a Monday; 02:00 UTC is inside 01:00-04:00
  expect(SessionUsage.calculateCost(costs, million, peak, new Date("2026-11-23T02:00:00Z"))).toBe(Money.USD.make(2))
})
test("skips the multiplier outside its window", () => {
  expect(SessionUsage.calculateCost(costs, million, peak, new Date("2026-11-23T12:00:00Z"))).toBe(Money.USD.make(1))
})
test("skips a multiplier whose conditions it cannot evaluate", () => {
  const tiered = [{ when: { service_tier: { equals: "priority" } }, factor: 2 }]
  expect(SessionUsage.calculateCost(costs, million, tiered, new Date("2026-11-23T02:00:00Z"))).toBe(Money.USD.make(1))
})
test("never changes a provider-reported cost", () => {
  const at = new Date("2026-11-23T02:00:00Z")
  expect(SessionUsage.record(new Usage({ nonCachedInputTokens: 1_000_000, cost: 0.25 }), costs, peak, at).cost).toBe(
    Money.USD.make(0.25),
  )
})

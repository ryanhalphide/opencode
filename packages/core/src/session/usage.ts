export * as SessionUsage from "./usage.js"

import type { Usage } from "@opencode/ai/effect"
import { Money } from "@opencode/schema/money"
import type { TokenUsage } from "@opencode/schema/token-usage"
import type { Model } from "@opencode/schema/model"

const finite = (value: number) => (Number.isFinite(value) ? value : 0)
const safe = (value: number | undefined) => Math.max(0, finite(value ?? 0))

export const tokens = (usage: Usage | undefined): TokenUsage.Info => ({
  input: safe(usage?.nonCachedInputTokens),
  output: safe(usage?.visibleOutputTokens),
  reasoning: safe(usage?.reasoningTokens),
  cache: {
    read: safe(usage?.cacheReadInputTokens),
    write: safe(usage?.cacheWriteInputTokens),
  },
})

type Multiplier = { readonly when: Readonly<Record<string, unknown>>; readonly factor: unknown }
const KNOWN_WHEN = new Set(["utc_days", "utc_hours", "any", "all", "not", "holiday"])
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Only conditions a catalog time multiplier can carry are evaluated. A clause naming anything else
// (service tier, region, date) makes the multiplier unevaluable, so it is skipped rather than applied
// to the wrong requests.
function evaluable(when: Record<string, unknown>): boolean {
  for (const key of Object.keys(when)) if (!KNOWN_WHEN.has(key)) return false
  if ("any" in when && (!Array.isArray(when.any) || !when.any.every((w) => isRecord(w) && evaluable(w)))) return false
  if ("all" in when && (!Array.isArray(when.all) || !when.all.every((w) => isRecord(w) && evaluable(w)))) return false
  if ("not" in when && (!isRecord(when.not) || !evaluable(when.not))) return false
  return true
}
function whenMatches(when: Record<string, unknown>, at: Date): boolean {
  if ("utc_days" in when) {
    const days = when.utc_days
    if (!isRecord(days) || !Array.isArray(days.in) || !days.in.includes(DAYS[at.getUTCDay()])) return false
  }
  if ("utc_hours" in when) {
    const hours = when.utc_hours
    if (!isRecord(hours)) return false
    const now = `${String(at.getUTCHours()).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`
    if (typeof hours.gte === "string" && now < hours.gte) return false
    if (typeof hours.lt === "string" && now >= hours.lt) return false
  }
  if ("any" in when && (!Array.isArray(when.any) || !when.any.some((w) => isRecord(w) && whenMatches(w, at))))
    return false
  if ("all" in when && (!Array.isArray(when.all) || !when.all.every((w) => isRecord(w) && whenMatches(w, at))))
    return false
  if ("not" in when && isRecord(when.not) && whenMatches(when.not, at)) return false
  if ("holiday" in when) return false
  return true
}
function multiplierFactor(multipliers: readonly Multiplier[] | undefined, at: Date): number {
  if (!multipliers) return 1
  let factor = 1
  for (const multiplier of multipliers) {
    if (typeof multiplier.factor !== "number") continue
    if (!isRecord(multiplier.when) || !evaluable(multiplier.when)) continue
    if (whenMatches(multiplier.when, at)) factor *= multiplier.factor
  }
  return factor
}

// Catalog pricing is the fallback for endpoints that don't report what they charged (`Usage.cost`).
export function calculateCost(
  costs: Model.Info["cost"],
  usage: TokenUsage.Info,
  multipliers?: Model.Info["costMultipliers"],
  at: Date = new Date(),
) {
  const context = usage.input + usage.cache.read + usage.cache.write
  const tier = costs
    .filter((cost) => cost.tier?.type === "context" && context > cost.tier.size)
    .toSorted((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0]
  const cost = tier ?? costs.find((cost) => cost.tier === undefined)
  if (!cost) return Money.USD.zero
  return Money.USD.make(
    ((usage.input * finite(cost.input) +
      (usage.output + usage.reasoning) * finite(cost.output) +
      usage.cache.read * finite(cost.cache.read) +
      usage.cache.write * finite(cost.cache.write)) /
      1_000_000) *
      multiplierFactor(multipliers, at),
  )
}

export type Recorded = {
  readonly tokens: TokenUsage.Info
  readonly cost: Money.USD
}

export const record = (
  usage: Usage | undefined,
  costs: Model.Info["cost"],
  multipliers?: Model.Info["costMultipliers"],
  at?: Date,
): Recorded => {
  const normalized = tokens(usage)
  return {
    tokens: normalized,
    // What an endpoint says it charged beats the catalog, which can't see its peak pricing, subscriptions or routing.
    // A reported zero is authoritative.
    cost: usage?.cost === undefined ? calculateCost(costs, normalized, multipliers, at) : Money.USD.make(usage.cost),
  }
}

export const add = (a: Recorded, b: Recorded): Recorded => ({
  cost: Money.USD.make(a.cost + b.cost),
  tokens: {
    input: a.tokens.input + b.tokens.input,
    output: a.tokens.output + b.tokens.output,
    reasoning: a.tokens.reasoning + b.tokens.reasoning,
    cache: {
      read: a.tokens.cache.read + b.tokens.cache.read,
      write: a.tokens.cache.write + b.tokens.cache.write,
    },
  },
})

/**
 * llmRuleAdapter.ts
 *
 * INPUT ADAPTER — plain English → DiscountRule
 *
 * Calls the serverless endpoint, then validates the answer again on this side
 * with the same schema the server used. The confirmation UI is never rendered on
 * the endpoint's word alone: if the payload doesn't satisfy `parsedRuleSchema`
 * here, it is treated as unresolvable input.
 *
 * Like every adapter, this file knows nothing about how discounts are computed.
 */

import {
  describeIssues,
  parsedRuleSchema,
  parseResponseSchema,
  toDiscountRule,
  type ParsedRule,
} from '../../engine/ruleSchema'
import type { DiscountRule } from '../../engine/types'

export type RuleParseOutcome =
  | { status: 'parsed'; rule: DiscountRule; parsed: ParsedRule }
  | { status: 'unresolvable'; reason: string }

/**
 * Recognises the common checkout wording for an additional, cart-wide
 * percentage discount without relying on the model. It deliberately accepts
 * only language that makes both its scope and its sequencing clear, such as:
 * "Additional 10% off the whole cart after all discounts".
 *
 * Cart-scoped stackable rules are applied last by the engine, each against the
 * amount left by the prior offer. This is the usual "90% off, then extra 10%"
 * promotion: Rs.100 becomes Rs.10, then Rs.9 — a total saving of Rs.91.
 */
export function parseAdditionalCartDiscount(
  text: string,
  ruleId: string
): RuleParseOutcome | null {
  const normalised = text.trim().toLowerCase()
  const percentage = normalised.match(/(\d+(?:\.\d+)?)\s*(?:%|percent(?:age)?)/)
  const signalsAdditionalDiscount = /\b(?:additional|extra|stackable)\b/.test(normalised)
  const wholeCartOrDiscount =
    /\b(?:whole|entire|full)\s+(?:cart|order|discounts?)\b/.test(normalised) ||
    /\bafter\s+(?:all|other|the\s+entire)\s+discounts?\b/.test(normalised)

  if (!percentage || !signalsAdditionalDiscount || !wholeCartOrDiscount) return null

  const parsed = parsedRuleSchema.safeParse({
    scope: 'cart',
    appliesTo: null,
    type: 'percentage',
    value: Number(percentage[1]),
    stackable: true,
  })

  if (!parsed.success) {
    return { status: 'unresolvable', reason: describeIssues(parsed.error).join('; ') }
  }

  return {
    status: 'parsed',
    parsed: parsed.data,
    rule: toDiscountRule(parsed.data, ruleId),
  }
}

/**
 * @param text   what the merchant typed
 * @param ruleId the id to assign if the parse succeeds (the app owns numbering)
 */
export async function parseRuleFromText(
  text: string,
  ruleId: string
): Promise<RuleParseOutcome> {
  // This phrase has fixed, unambiguous checkout semantics. Handling it locally
  // makes the new promotion work even when the optional model parser is not
  // configured, while all other natural-language rules keep using the API.
  const additionalCartDiscount = parseAdditionalCartDiscount(text, ruleId)
  if (additionalCartDiscount) return additionalCartDiscount

  let payload: unknown

  try {
    const response = await fetch('/api/parse-rule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    payload = await response.json()
  } catch {
    return {
      status: 'unresolvable',
      reason: "Couldn't reach the rule parser. Check your connection and try again.",
    }
  }

  // The endpoint answers with the same {ok} envelope for both outcomes, so a
  // non-2xx status still carries a readable reason — parse the body either way.
  const envelope = parseResponseSchema.safeParse(payload)
  if (!envelope.success) {
    const reason =
      typeof (payload as { reason?: unknown })?.reason === 'string'
        ? (payload as { reason: string }).reason
        : 'The rule parser returned something unexpected. Please try again.'
    return { status: 'unresolvable', reason }
  }

  if (!envelope.data.ok) {
    return { status: 'unresolvable', reason: envelope.data.reason }
  }

  // Second, independent validation before anything is shown as confirmable.
  const recheck = parsedRuleSchema.safeParse(envelope.data.rule)
  if (!recheck.success) {
    return { status: 'unresolvable', reason: describeIssues(recheck.error).join('; ') }
  }

  return {
    status: 'parsed',
    parsed: recheck.data,
    rule: toDiscountRule(recheck.data, ruleId),
  }
}

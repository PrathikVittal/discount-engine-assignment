/**
 * ruleSchema.ts
 *
 * One definition of "a valid discount rule", shared by the serverless LLM
 * endpoint and the browser. The endpoint validates before responding; the client
 * validates again before showing a confirmation card. Duplicated on purpose —
 * the UI should never render a rule for confirmation on the endpoint's word alone.
 *
 * These refinements are also what turn vague input into a clean "unresolvable"
 * message instead of a crash: "give a discount for big orders" has no value and
 * no threshold, so it cannot satisfy the schema no matter what the model returns.
 */

import { z } from 'zod'
import type { DiscountRule } from './types'

/** A rule as parsed from natural language — no `ruleId` yet, the app assigns that. */
export const parsedRuleSchema = z
  .object({
    scope: z.enum(['brand', 'platform', 'cart']),
    appliesTo: z.string().trim().min(1).nullable(),
    type: z.enum(['percentage', 'flat']),
    value: z.number().positive('Discount value must be greater than zero'),
    stackable: z.boolean(),
    minCartValue: z.number().positive().optional(),
  })
  // Note: a cart rule may legitimately have NO minCartValue — "20% off the whole
  // cart" is an unconditional offer that always qualifies. What must never pass
  // is a rule whose text *implies* a threshold without stating it ("big orders");
  // that's caught upstream by the model returning understood=false, because the
  // difference is one of intent, not of shape.
  .refine((rule) => rule.scope === 'cart' || rule.appliesTo !== null, {
    message: 'A brand or platform offer needs to say which brand or platform it applies to',
    path: ['appliesTo'],
  })
  .refine((rule) => rule.type !== 'percentage' || rule.value <= 100, {
    message: 'A percentage discount cannot exceed 100%',
    path: ['value'],
  })

export type ParsedRule = z.infer<typeof parsedRuleSchema>

/** What the LLM endpoint returns: either a rule it could resolve, or why it could not. */
export const parseResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), rule: parsedRuleSchema }),
  z.object({ ok: z.literal(false), reason: z.string().min(1) }),
])

export type ParseResponse = z.infer<typeof parseResponseSchema>

/**
 * The JSON shape handed to the model. Kept next to the schema so the prompt and
 * the validator can never drift apart.
 */
export const RULE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    scope: {
      type: 'string',
      enum: ['brand', 'platform', 'cart'],
      description:
        'Use "brand" when the offer targets a brand name, "platform" when it targets a marketplace (Amazon India, Flipkart, Noon), "cart" when it applies to the whole order based on a total.',
    },
    appliesTo: {
      type: ['string', 'null'],
      description:
        'The exact brand or platform name the offer targets. Must be null when scope is "cart".',
    },
    type: {
      type: 'string',
      enum: ['percentage', 'flat'],
      description: '"percentage" for "20% off", "flat" for "Rs.100 off".',
    },
    value: {
      type: 'number',
      description:
        'The discount amount: 20 for "20% off", 100 for "Rs.100 off". Must be stated in the input — never invent one.',
    },
    stackable: {
      type: 'boolean',
      description:
        'True when the text says the offer combines/stacks with other offers. For an additional cart-wide discount, true means it applies to the remaining cart total after other discounts.',
    },
    minCartValue: {
      type: 'number',
      description:
        'Required for scope "cart": the minimum order total that unlocks the offer. Omit otherwise.',
    },
  },
  required: ['scope', 'appliesTo', 'type', 'value', 'stackable'],
  additionalProperties: false,
} as const

/** Turns a validated parse into an engine-ready rule by assigning it an id. */
export function toDiscountRule(parsed: ParsedRule, ruleId: string): DiscountRule {
  return {
    ruleId,
    scope: parsed.scope,
    appliesTo: parsed.scope === 'cart' ? null : parsed.appliesTo,
    type: parsed.type,
    value: parsed.value,
    stackable: parsed.stackable,
    ...(parsed.minCartValue !== undefined ? { minCartValue: parsed.minCartValue } : {}),
  }
}

/** Flattens Zod issues into the plain sentences the UI shows the user. */
export function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.join('.')
    return field ? `${field}: ${issue.message}` : issue.message
  })
}

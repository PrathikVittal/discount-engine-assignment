/**
 * _parseRule.ts
 *
 * The natural-language → DiscountRule parse, with no HTTP framework around it.
 * The Vercel function (`api/parse-rule.ts`) and the Vite dev middleware both
 * call `parseRuleFromText`, so local dev and production run identical logic.
 *
 * The API key is read from the environment here, server-side. It is never sent
 * to the browser — see ARCHITECTURE.md §7 for why this one endpoint exists in an
 * otherwise fully client-side app.
 *
 * The model is asked for a deliberately *loose* shape (every field nullable, plus
 * an explicit `understood` flag) and the strict rules are applied afterwards by
 * `parsedRuleSchema`. A model forced to choose between a valid-looking guess and
 * an honest "not stated" will guess — so it's given a way to say it doesn't know.
 */

import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { z } from 'zod'
import { describeIssues, parsedRuleSchema, type ParseResponse } from '../src/engine/ruleSchema'

/** Overridable so the model can be changed without a code edit. */
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.1'

/**
 * The shape requested from the model.
 *
 * Every field is nullable and *required* — OpenAI's strict structured output
 * mode disallows optional fields, and nullability is what gives the model a way
 * to report "not stated" rather than inventing a value.
 */
const llmOutputSchema = z.object({
  understood: z
    .boolean()
    .describe('True only if this describes a concrete discount with a stated amount.'),
  reason: z
    .string()
    .nullable()
    .describe('When understood is false, the specific thing that is missing or ambiguous.'),
  scope: z.enum(['brand', 'platform', 'cart']).nullable(),
  appliesTo: z
    .string()
    .nullable()
    .describe('The brand or platform name. Null for cart-wide offers.'),
  type: z.enum(['percentage', 'flat']).nullable(),
  value: z
    .number()
    .nullable()
    .describe('20 for "20% off", 100 for "Rs.100 off". Null if no amount is stated.'),
  stackable: z
    .boolean()
    .nullable()
    .describe('True if the text says the offer combines or stacks with other offers. An additional cart-wide offer that applies after discounts is stackable.'),
  minCartValue: z
    .number()
    .nullable()
    .describe('For cart-wide offers, the order total that unlocks the discount. Null if none.'),
})

const SYSTEM_PROMPT = `You convert a merchant's plain-English description of a discount into a structured rule for a cart pricing engine.

Scope:
- "brand"    — the offer targets a product brand (e.g. Natura Casa, LivSpace Pro, Nordic Basics).
- "platform" — the offer targets a marketplace (e.g. Amazon India, Flipkart, Noon).
- "cart"     — the offer applies to the whole order. appliesTo must be null.

Rules you must follow:
- Never invent a discount amount. If the text does not state one, set understood=false.
- minCartValue is OPTIONAL. Set it only when the text states an actual threshold ("over Rs.5,000", "above 10000"). Leave it null when the offer is unconditional — "20% off the whole cart", "10% off every order" apply to any cart and are perfectly valid.
- But if the text gestures at a threshold without stating a number ("big orders", "large carts", "bulk purchases"), set understood=false — a vague size is not a threshold, and you must not guess one.
- stackable is true ONLY if the text says the offer combines/stacks with other offers. An "additional" or "extra" cart-wide percentage that says it applies after all discounts is stackable=true; it runs against the remaining cart total, not the original total.
- "Rs.", "INR", "₹" and "rupees" indicate a flat amount. "%" or "percent" indicates a percentage.
- When understood=false, put the specific missing piece in "reason", phrased for the merchant to act on.

Examples:
"20% off for Natura Casa brand, stackable with other offers"
  → understood=true, scope=brand, appliesTo="Natura Casa", type=percentage, value=20, stackable=true, minCartValue=null
"Rs.100 flat discount on all Flipkart items"
  → understood=true, scope=platform, appliesTo="Flipkart", type=flat, value=100, stackable=false, minCartValue=null
"10% off if cart value is more than Rs.5,000"
  → understood=true, scope=cart, appliesTo=null, type=percentage, value=10, stackable=false, minCartValue=5000
"Knock off 20% of the whole cart"
  → understood=true, scope=cart, appliesTo=null, type=percentage, value=20, stackable=false, minCartValue=null
"Additional 10% off the whole cart after all discounts"
  → understood=true, scope=cart, appliesTo=null, type=percentage, value=10, stackable=true, minCartValue=null
"Additional 20% off whole discount, stackable. Used after the entire discount applied."
  → understood=true, scope=cart, appliesTo=null, type=percentage, value=20, stackable=true, minCartValue=null
"Give a discount for big orders"
  → understood=false, reason="No discount amount or order threshold was given. Try something like \\"10% off orders over Rs.5,000\\"."
"15% off big orders"
  → understood=false, reason="\\"Big orders\\" doesn't specify a cart total. Try \\"15% off orders over Rs.5,000\\", or say \\"15% off the whole cart\\" if it should apply to every order."`

/** Raised only for genuine configuration problems, so the UI can say so specifically. */
export class NotConfiguredError extends Error {}

/** Raised when the model is reachable but rate-limited or overloaded. */
export class ModelBusyError extends Error {
  /** Seconds the API asked us to wait, when it told us. */
  readonly retryAfterSeconds?: number

  constructor(message: string, retryAfterSeconds?: number) {
    super(message)
    this.retryAfterSeconds = retryAfterSeconds
  }

  /** Customer-facing phrasing — concrete when we know the wait, vague when not. */
  get userMessage(): string {
    if (this.retryAfterSeconds && this.retryAfterSeconds > 5) {
      return `The rule parser has hit its rate limit — try again in about ${Math.ceil(
        this.retryAfterSeconds
      )} seconds.`
    }
    return 'The rule parser is busy right now — wait a moment and try again.'
  }
}

/** Longest we'll make a user wait before admitting the parser is busy. */
const MAX_BACKOFF_MS = 6000

function isRetryable(error: unknown): boolean {
  const status = (error as { status?: number })?.status
  if (status === 429 || (status !== undefined && status >= 500)) return true
  return /\b(429|500|502|503|504|ECONNRESET|ETIMEDOUT)\b/.test(String((error as Error)?.message ?? ''))
}

/**
 * Rate-limit errors carry the wait the server actually wants — OpenAI sends it
 * both as a `retry-after` header and inside the message ("try again in 1.5s").
 * Honouring that beats guessing: a blind backoff gives up while the window is
 * still closed.
 */
function suggestedDelaySeconds(error: unknown): number | null {
  const header = (error as { headers?: Record<string, string> })?.headers?.['retry-after']
  if (header && Number.isFinite(Number(header))) return Number(header)

  const message = String((error as Error)?.message ?? '')
  const match =
    message.match(/try again in (\d+(?:\.\d+)?)s/i) ??
    message.match(/retry after (\d+(?:\.\d+)?)/i)
  return match?.[1] ? Number(match[1]) : null
}

/**
 * Free/low tiers rate-limit readily, and a transient 429 shouldn't look to the
 * user like their sentence was unparseable. Anything non-transient throws
 * straight through so a real error isn't hidden behind retries.
 */
async function withRetry<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (!isRetryable(error)) throw error

      const hinted = suggestedDelaySeconds(error)

      // If the API wants longer than we're willing to hold the request open,
      // stop retrying and tell the user the real wait instead of stalling them.
      if (hinted !== null && hinted * 1000 > MAX_BACKOFF_MS) {
        throw new ModelBusyError(String((error as Error)?.message ?? ''), hinted)
      }

      if (attempt < attempts - 1) {
        const wait =
          hinted !== null ? hinted * 1000 + 250 : Math.min(500 * 2 ** attempt, MAX_BACKOFF_MS)
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
  }

  throw new ModelBusyError(
    String((lastError as Error)?.message ?? 'model unavailable'),
    suggestedDelaySeconds(lastError) ?? undefined
  )
}

export async function parseRuleFromText(rawText: unknown): Promise<ParseResponse> {
  const text = typeof rawText === 'string' ? rawText.trim() : ''

  if (!text) {
    return { ok: false, reason: 'Describe the offer you want to add first.' }
  }
  if (text.length > 500) {
    return { ok: false, reason: 'That description is too long — keep it to one sentence.' }
  }

  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new NotConfiguredError(
      'OPENAI_API_KEY is not set on the server, so natural-language rules cannot be parsed.'
    )
  }

  const client = new OpenAI({ apiKey })

  const response = await withRetry(() =>
    client.responses.parse({
      model: MODEL,
      instructions: SYSTEM_PROMPT,
      input: text,
      text: { format: zodTextFormat(llmOutputSchema, 'discount_rule') },
    })
  )

  const parsed = response.output_parsed
  if (!parsed) {
    return { ok: false, reason: "Couldn't read that as a discount rule. Try rephrasing it." }
  }

  // The model itself reported that the input is too vague to resolve.
  if (!parsed.understood) {
    return {
      ok: false,
      reason:
        parsed.reason ??
        'That description is missing a discount amount. Try something like "15% off Flipkart items".',
    }
  }

  // Re-validate the model's answer against the strict schema. Anything it got
  // wrong (a brand rule naming no brand, 150% off) is caught here and reported
  // as unresolvable rather than reaching the cart.
  const validated = parsedRuleSchema.safeParse({
    scope: parsed.scope,
    appliesTo: parsed.scope === 'cart' ? null : parsed.appliesTo,
    type: parsed.type,
    value: parsed.value,
    stackable: parsed.stackable ?? false,
    ...(parsed.minCartValue != null ? { minCartValue: parsed.minCartValue } : {}),
  })

  if (!validated.success) {
    return { ok: false, reason: describeIssues(validated.error).join('; ') }
  }

  return { ok: true, rule: validated.data }
}

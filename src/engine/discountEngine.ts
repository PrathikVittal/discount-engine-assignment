/**
 * discountEngine.ts
 *
 * Pure discount calculation. No UI, no I/O, no knowledge of CSV / LLM / PDF.
 * Takes plain data in, returns plain data out — the same inputs always produce
 * the same outputs, which is what makes the whole thing testable and re-runnable.
 *
 * Selection logic:
 *   1. Collect the rules matching an item, split into non-stackable and stackable.
 *   2. Among non-stackable matches, the LARGEST rupee saving wins. Scope is
 *      irrelevant — a brand rule and a platform rule compete purely on amount.
 *   3. Stackable rules apply on top of that result. With no non-stackable winner,
 *      a stackable rule applies to the base price on its own.
 *   4. No matches → base price + "No offers available".
 *   5. Cart rules run LAST, against the sum of final item prices, as a separate
 *      line — never folded into any item.
 */

import type {
  CartCalculationResult,
  CartItem,
  CartOfferLine,
  CartOfferResult,
  DiscountRule,
  ItemDiscountResult,
} from './types'

/**
 * Rounding policy: round to the nearest rupee after EVERY discount step.
 *
 * The brief mixes exact and rounded figures in one example (RULE-01 on ITEM-01 is
 * described as "Rs.194.85 off" but the result is Rs.1,104, i.e. a Rs.195 saving).
 * Rounding once at the very end does not reproduce the brief's own numbers for
 * ITEM-02 (849 → 699 → 629) or the cart total (5,932 → 5,339); rounding at each
 * step does, for all six items. So: round at each step. Prices are whole rupees
 * everywhere, which is also what a customer expects to see at checkout.
 */
function toRupees(amount: number): number {
  return Math.round(amount)
}

/** True when a rule targets this item. Cart rules never match an item. */
export function ruleMatchesItem(item: CartItem, rule: DiscountRule): boolean {
  if (rule.appliesTo === null) return false
  const normalise = (s: string) => s.trim().toLowerCase()
  const target = normalise(rule.appliesTo)

  if (rule.scope === 'brand') return normalise(item.brand) === target
  if (rule.scope === 'platform') return normalise(item.platform) === target
  return false // 'cart' — handled separately, never per item
}

/**
 * The rupee saving a rule produces against a given price.
 * Percentage rules use the price passed in, not the original base price — that
 * is what makes stacking compound correctly.
 */
export function discountAmount(price: number, rule: DiscountRule): number {
  if (rule.type === 'percentage') return toRupees((price * rule.value) / 100)
  if (rule.type === 'flat') return Math.min(rule.value, price) // never below Rs.0
  return 0
}

/** Customer-facing phrasing for a single rule. */
function describeRule(rule: DiscountRule): string {
  const scopeLabel = rule.scope === 'brand' ? 'Brand' : 'Platform'
  if (rule.type === 'percentage') return `${scopeLabel} offer: ${rule.value}% off`
  return `${scopeLabel} offer: Rs.${rule.value.toLocaleString('en-IN')} off`
}

/**
 * Applies item-level rules to one cart item. Steps 1–4 of the selection logic.
 * `rules` must already exclude cart-scoped rules.
 */
export function applyItemDiscounts(
  item: CartItem,
  rules: DiscountRule[]
): ItemDiscountResult {
  const base = {
    itemId: item.itemId,
    product: item.product,
    brand: item.brand,
    platform: item.platform,
    basePrice: item.basePrice,
  }

  const matching = rules.filter((rule) => ruleMatchesItem(item, rule))

  // (4) Nothing matched — say so in plain language rather than showing a bare price.
  if (matching.length === 0) {
    return {
      ...base,
      finalPrice: item.basePrice,
      totalDiscount: 0,
      appliedRules: [],
      skippedRules: [],
      reasoning: 'No offers available',
    }
  }

  const nonStackable = matching.filter((rule) => !rule.stackable)
  const stackable = matching.filter((rule) => rule.stackable)

  let price = item.basePrice
  const appliedRules: string[] = []
  const skippedRules: string[] = []
  const reasonParts: string[] = []

  // (2) Largest rupee saving wins among non-stackable rules.
  if (nonStackable.length > 0) {
    const ranked = [...nonStackable].sort(
      (a, b) => discountAmount(item.basePrice, b) - discountAmount(item.basePrice, a)
    )
    const winner = ranked[0]!
    price -= discountAmount(price, winner)
    appliedRules.push(winner.ruleId)
    reasonParts.push(describeRule(winner))
    skippedRules.push(...ranked.slice(1).map((rule) => rule.ruleId))
  }

  // (3) Stackable rules apply on top, each against the already-discounted price.
  for (const rule of stackable) {
    price -= discountAmount(price, rule)
    appliedRules.push(rule.ruleId)
    reasonParts.push(describeRule(rule))
  }

  const finalPrice = toRupees(price)

  return {
    ...base,
    finalPrice,
    totalDiscount: item.basePrice - finalPrice,
    appliedRules,
    skippedRules,
    reasoning: reasonParts.join(' + '),
  }
}

/** Describes one cart offer for the summary line. */
function cartOfferLine(rule: DiscountRule, amountSaved: number): CartOfferLine {
  const offerText =
    rule.type === 'percentage'
      ? `${rule.value}% off`
      : `Rs.${rule.value.toLocaleString('en-IN')} off`

  return {
    ruleId: rule.ruleId,
    type: rule.type,
    value: rule.value,
    amountSaved,
    stackable: rule.stackable,
    reasoning: `${
      rule.stackable ? 'Additional cart offer (after other discounts)' : 'Cart offer'
    }: ${offerText} — Rs.${amountSaved.toLocaleString('en-IN')} saved`,
  }
}

/**
 * (5) Evaluates cart-scoped rules against the post-item-discount subtotal.
 *
 * Cart rules follow exactly the same selection logic as item rules: among the
 * qualifying non-stackable ones the largest rupee saving wins, and every
 * qualifying *stackable* cart rule then applies on top of that running total.
 * Returning only a single winner (as an earlier version did) silently discarded
 * a stackable cart rule whenever a larger non-stackable one also qualified.
 *
 * Thresholds are inclusive (`>=`) — the brief says "meets or exceeds". Any rule
 * the customer has *not* unlocked is reported as `nearMiss`, whether or not
 * another cart offer already applied, so the UI can always show what's next.
 */
export function pickCartOffer(
  cartRules: DiscountRule[],
  subtotal: number
): CartOfferResult {
  const threshold = (rule: DiscountRule) => rule.minCartValue ?? 0
  const qualifying = cartRules.filter((rule) => subtotal >= threshold(rule))
  const unmet = cartRules.filter((rule) => subtotal < threshold(rule))

  // Closest threshold not yet reached — useful even when another offer applied.
  const nearest = [...unmet].sort((a, b) => threshold(a) - threshold(b))[0]
  const nearMiss = nearest
    ? {
        nearMiss: {
          ruleId: nearest.ruleId,
          minCartValue: threshold(nearest),
          shortfall: threshold(nearest) - subtotal,
        },
      }
    : {}

  if (qualifying.length === 0) {
    return { applied: false, lines: [], totalSaved: 0, skippedRules: [], ...nearMiss }
  }

  const nonStackable = qualifying.filter((rule) => !rule.stackable)
  const stackable = qualifying.filter((rule) => rule.stackable)

  let running = subtotal
  const lines: CartOfferLine[] = []
  const skippedRules: string[] = []

  // Largest rupee saving wins among non-stackable cart rules.
  if (nonStackable.length > 0) {
    const ranked = [...nonStackable].sort(
      (a, b) => discountAmount(subtotal, b) - discountAmount(subtotal, a)
    )
    const winner = ranked[0]!
    const saved = discountAmount(running, winner)
    running -= saved
    lines.push(cartOfferLine(winner, saved))
    skippedRules.push(...ranked.slice(1).map((rule) => rule.ruleId))
  }

  // Stackable cart rules apply on top, each against the running total.
  for (const rule of stackable) {
    const saved = discountAmount(running, rule)
    running -= saved
    lines.push(cartOfferLine(rule, saved))
  }

  return {
    applied: true,
    lines,
    totalSaved: subtotal - running,
    skippedRules,
    ...nearMiss,
  }
}

/**
 * The engine's single entry point.
 *
 * Every input path — CSV, natural language, PDF — ends here with the same two
 * arguments. Adding a new input mode means writing a new adapter, not editing
 * this function.
 */
export function calculate(
  cart: CartItem[],
  rules: DiscountRule[]
): CartCalculationResult {
  const itemRules = rules.filter((rule) => rule.scope !== 'cart')
  const cartRules = rules.filter((rule) => rule.scope === 'cart')

  const items = cart.map((item) => applyItemDiscounts(item, itemRules))
  const subtotal = items.reduce((sum, result) => sum + result.finalPrice, 0)

  const cartOffer = pickCartOffer(cartRules, subtotal)
  const finalTotal = subtotal - cartOffer.totalSaved

  const baseTotal = cart.reduce((sum, item) => sum + item.basePrice, 0)

  return {
    items,
    subtotal,
    cartOffer,
    finalTotal,
    totalSaved: baseTotal - finalTotal,
  }
}

/**
 * types.ts
 *
 * The contract between input adapters and the discount engine.
 *
 * Everything to the LEFT of this file (CSV / LLM / PDF adapters) exists only to
 * produce `CartItem[]` and `DiscountRule[]`.
 * Everything to the RIGHT of it (the engine) consumes only those two shapes and
 * never learns where they came from.
 *
 * That is what lets a fourth input mode be added without touching the calculator.
 */

// ── Inputs ────────────────────────────────────────────────────────

/**
 * Where a rule applies. `cart` rules act on the whole cart after item-level
 * offers, not on any individual item.
 */
export type RuleScope = 'brand' | 'platform' | 'cart'

export type RuleType = 'percentage' | 'flat'

export interface DiscountRule {
  ruleId: string
  scope: RuleScope
  /** Brand or platform name to match. `null` for cart-scoped rules. */
  appliesTo: string | null
  type: RuleType
  /** Percentage as an integer (15 = 15% off), or flat amount in rupees. */
  value: number
  /**
   * Stackable rules apply to the remaining amount after the winning offer. A
   * stackable cart rule is therefore an additional checkout discount, applied
   * after all item offers and the winning cart offer.
   */
  stackable: boolean
  /** Minimum cart subtotal required. Only meaningful for `scope: 'cart'`. */
  minCartValue?: number
}

export interface CartItem {
  itemId: string
  product: string
  brand: string
  platform: string
  /** In rupees. */
  basePrice: number
}

// ── Engine output (what the UI renders) ───────────────────────────

export interface ItemDiscountResult {
  itemId: string
  product: string
  brand: string
  platform: string
  basePrice: number
  finalPrice: number
  totalDiscount: number
  /** Rule ids actually applied, in the order they were applied. */
  appliedRules: string[]
  /** Non-stackable rules that matched but lost the max-saving comparison. */
  skippedRules: string[]
  /** Customer-facing explanation, e.g. "Platform offer: 15% off". */
  reasoning: string
}

/** One cart-level offer that fired, as its own line in the summary. */
export interface CartOfferLine {
  ruleId: string
  type: RuleType
  value: number
  amountSaved: number
  stackable: boolean
  /** e.g. "Cart offer: 10% off — Rs.593 saved" */
  reasoning: string
}

export interface CartOfferResult {
  applied: boolean
  /**
   * Every cart offer applied, in application order: the winning non-stackable
   * rule first, then any stackable cart rules on top of it. Cart rules follow
   * the same max-saving-then-stack logic as item rules — a stackable cart rule
   * must not be dropped just because a bigger non-stackable one also qualified.
   */
  lines: CartOfferLine[]
  /** Sum of every line's saving. */
  totalSaved: number
  /** Cart rules that qualified but lost the max-saving comparison. */
  skippedRules: string[]
  /** The closest cart rule the customer has *not* unlocked yet, if any. */
  nearMiss?: {
    ruleId: string
    minCartValue: number
    /** How much more the customer needs to spend to unlock it. */
    shortfall: number
  }
}

export interface CartCalculationResult {
  items: ItemDiscountResult[]
  /** Sum of item final prices, before any cart-level offer. */
  subtotal: number
  cartOffer: CartOfferResult
  /** `subtotal` minus the cart offer, or equal to `subtotal` when none applied. */
  finalTotal: number
  /** Total saved against the sum of base prices, including the cart offer. */
  totalSaved: number
}

// ── Adapter contract ──────────────────────────────────────────────

/**
 * Every input adapter returns this shape — never throws, never partially applies.
 * `data` holds the rows that parsed cleanly; `errors` holds human-readable
 * messages for the rows that did not. A malformed row is skipped, not fatal.
 */
export interface AdapterResult<T> {
  data: T[]
  errors: string[]
}

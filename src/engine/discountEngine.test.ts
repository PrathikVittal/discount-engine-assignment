/**
 * discountEngine.test.ts
 *
 * Locks the engine to the exact figures in the assignment brief, plus the edge
 * cases the brief calls out as judgment calls (threshold boundary, stacking with
 * no non-stackable winner, no-match items).
 *
 * Because the engine is pure, these tests need no DOM, no files and no network.
 */

import { describe, expect, it } from 'vitest'
import { calculate, applyItemDiscounts, pickCartOffer } from './discountEngine'
import type { CartItem, DiscountRule } from './types'

const RULES: DiscountRule[] = [
  { ruleId: 'RULE-01', scope: 'platform', appliesTo: 'Amazon India', type: 'percentage', value: 15, stackable: false },
  { ruleId: 'RULE-02', scope: 'brand', appliesTo: 'Natura Casa', type: 'flat', value: 150, stackable: false },
  { ruleId: 'RULE-03', scope: 'platform', appliesTo: 'Flipkart', type: 'percentage', value: 10, stackable: true },
  { ruleId: 'RULE-04', scope: 'cart', appliesTo: null, type: 'percentage', value: 10, stackable: false, minCartValue: 4000 },
]

const CART: CartItem[] = [
  { itemId: 'ITEM-01', product: 'Cushion Cover', brand: 'Natura Casa', platform: 'Amazon India', basePrice: 1299 },
  { itemId: 'ITEM-02', product: 'Bed Sheet Set', brand: 'Natura Casa', platform: 'Flipkart', basePrice: 849 },
  { itemId: 'ITEM-03', product: 'Wall Shelf', brand: 'LivSpace Pro', platform: 'Amazon India', basePrice: 599 },
  { itemId: 'ITEM-04', product: 'Ceramic Vase', brand: 'LivSpace Pro', platform: 'Noon', basePrice: 2499 },
  { itemId: 'ITEM-05', product: 'Cutting Board', brand: 'Nordic Basics', platform: 'Amazon India', basePrice: 449 },
  { itemId: 'ITEM-06', product: 'Desk Organiser', brand: 'Nordic Basics', platform: 'Flipkart', basePrice: 899 },
]

describe('the assignment’s expected results', () => {
  const result = calculate(CART, RULES)
  const byId = Object.fromEntries(result.items.map((i) => [i.itemId, i]))

  it.each([
    ['ITEM-01', 1104],
    ['ITEM-02', 629],
    ['ITEM-03', 509],
    ['ITEM-04', 2499],
    ['ITEM-05', 382],
    ['ITEM-06', 809],
  ])('%s final price is Rs.%i', (itemId, expected) => {
    expect(byId[itemId]!.finalPrice).toBe(expected)
  })

  it('subtotals the item finals to Rs.5,932', () => {
    expect(result.subtotal).toBe(5932)
  })

  it('applies RULE-04 as a separate Rs.593 cart offer', () => {
    expect(result.cartOffer.applied).toBe(true)
    expect(result.cartOffer.lines).toHaveLength(1)
    expect(result.cartOffer.lines[0]!.ruleId).toBe('RULE-04')
    expect(result.cartOffer.lines[0]!.amountSaved).toBe(593)
    expect(result.cartOffer.totalSaved).toBe(593)
  })

  it('lands on a Rs.5,339 final cart total', () => {
    expect(result.finalTotal).toBe(5339)
  })
})

describe('rule selection', () => {
  it('picks the larger rupee saving, ignoring scope (ITEM-01: 15% beats Rs.150)', () => {
    const item = applyItemDiscounts(CART[0]!, RULES)
    expect(item.appliedRules).toEqual(['RULE-01'])
    expect(item.skippedRules).toEqual(['RULE-02'])
    expect(item.reasoning).toBe('Platform offer: 15% off')
  })

  it('stacks a stackable rule on top of the winner (ITEM-02)', () => {
    const item = applyItemDiscounts(CART[1]!, RULES)
    expect(item.appliedRules).toEqual(['RULE-02', 'RULE-03'])
    expect(item.finalPrice).toBe(629)
    expect(item.reasoning).toBe('Brand offer: Rs.150 off + Platform offer: 10% off')
  })

  it('applies a stackable rule alone when no non-stackable rule matched (ITEM-06)', () => {
    const item = applyItemDiscounts(CART[5]!, RULES)
    expect(item.appliedRules).toEqual(['RULE-03'])
    expect(item.finalPrice).toBe(809)
  })

  it('explains itself when nothing matches (ITEM-04)', () => {
    const item = applyItemDiscounts(CART[3]!, RULES)
    expect(item.finalPrice).toBe(item.basePrice)
    expect(item.totalDiscount).toBe(0)
    expect(item.reasoning).toBe('No offers available')
  })

  it('never lets a flat discount push a price below zero', () => {
    const cheap: CartItem = { itemId: 'X', product: 'Coaster', brand: 'Natura Casa', platform: 'Noon', basePrice: 99 }
    const item = applyItemDiscounts(cheap, RULES)
    expect(item.finalPrice).toBe(0)
  })
})

describe('the cart threshold boundary', () => {
  const cartRule = RULES[3]!

  it('fires exactly at the threshold (>=, not >)', () => {
    expect(pickCartOffer([cartRule], 4000).applied).toBe(true)
  })

  it('does not fire one rupee below it', () => {
    expect(pickCartOffer([cartRule], 3999).applied).toBe(false)
  })

  it('reports how far a near-miss cart is from qualifying', () => {
    const offer = pickCartOffer([cartRule], 3999)
    expect(offer.nearMiss).toEqual({ ruleId: 'RULE-04', minCartValue: 4000, shortfall: 1 })
  })

  it('applies an unconditional cart rule at any total', () => {
    const unconditional: DiscountRule = {
      ruleId: 'RULE-09', scope: 'cart', appliesTo: null,
      type: 'percentage', value: 20, stackable: false,
    }
    // No minCartValue at all — should fire even on a tiny cart.
    const offer = pickCartOffer([unconditional], 100)
    expect(offer.applied).toBe(true)
    expect(offer.totalSaved).toBe(20)
    expect(offer.nearMiss).toBeUndefined()
  })

  it('leaves the total untouched when no cart rule qualifies', () => {
    const smallCart = [CART[2]!] // Rs.599 → Rs.509
    const result = calculate(smallCart, RULES)
    expect(result.subtotal).toBe(509)
    expect(result.cartOffer.applied).toBe(false)
    expect(result.cartOffer.lines).toEqual([])
    expect(result.finalTotal).toBe(509)
  })
})

/**
 * Regression: a stackable CART rule must apply on top of the winning
 * non-stackable cart rule, exactly as at item level.
 *
 * This was a real bug — `pickCartOffer` returned a single winner, so whenever a
 * larger non-stackable cart rule also qualified the stackable one was silently
 * dropped and the customer was overcharged. It never showed up against the
 * brief's sample data because that has only one cart rule.
 */
describe('stacking at cart level', () => {
  const CART_RULES: DiscountRule[] = [
    { ruleId: 'RULE-04', scope: 'cart', appliesTo: null, type: 'percentage', value: 10, stackable: false, minCartValue: 4000 },
    { ruleId: 'RULE-13', scope: 'cart', appliesTo: null, type: 'percentage', value: 5, stackable: true, minCartValue: 8000 },
  ]

  it('stacks a qualifying stackable cart rule on top of the winner', () => {
    const offer = pickCartOffer(CART_RULES, 47950)

    expect(offer.lines.map((l) => l.ruleId)).toEqual(['RULE-04', 'RULE-13'])
    expect(offer.lines[0]!.amountSaved).toBe(4795) // 10% of 47,950
    expect(offer.lines[1]!.amountSaved).toBe(2158) // 5% of the remaining 43,155
    expect(offer.totalSaved).toBe(6953)
  })

  it('produces the correct final total for the 30-item cart', () => {
    // Subtotal after item discounts is Rs.47,950.
    const offer = pickCartOffer(CART_RULES, 47950)
    expect(47950 - offer.totalSaved).toBe(40997)
  })

  it('applies a stackable cart rule alone when no non-stackable one qualifies', () => {
    // Rs.9,000 clears RULE-13's Rs.8,000 threshold but we drop RULE-04 here.
    const offer = pickCartOffer([CART_RULES[1]!], 9000)
    expect(offer.lines.map((l) => l.ruleId)).toEqual(['RULE-13'])
    expect(offer.totalSaved).toBe(450)
  })

  it('compounds an additional discount on the amount left after a 90% sale', () => {
    const offer = pickCartOffer(
      [
        { ruleId: 'SALE-90', scope: 'cart', appliesTo: null, type: 'percentage', value: 90, stackable: false },
        { ruleId: 'EXTRA-10', scope: 'cart', appliesTo: null, type: 'percentage', value: 10, stackable: true },
      ],
      100
    )

    // Rs.100 → Rs.10 after the sale → Rs.9 after the extra 10%.
    expect(offer.lines.map((line) => [line.ruleId, line.amountSaved])).toEqual([
      ['SALE-90', 90],
      ['EXTRA-10', 1],
    ])
    expect(offer.totalSaved).toBe(91)
  })

  it('reports a cart rule still out of reach even when another already applied', () => {
    // Rs.5,000 clears RULE-04 but not RULE-13.
    const offer = pickCartOffer(CART_RULES, 5000)
    expect(offer.lines.map((l) => l.ruleId)).toEqual(['RULE-04'])
    expect(offer.nearMiss).toEqual({ ruleId: 'RULE-13', minCartValue: 8000, shortfall: 3000 })
  })

  it('still picks the largest saving among competing non-stackable cart rules', () => {
    const competing: DiscountRule[] = [
      { ruleId: 'A', scope: 'cart', appliesTo: null, type: 'percentage', value: 10, stackable: false, minCartValue: 1000 },
      { ruleId: 'B', scope: 'cart', appliesTo: null, type: 'flat', value: 500, stackable: false, minCartValue: 1000 },
    ]
    const offer = pickCartOffer(competing, 10000) // 10% = 1000 beats flat 500
    expect(offer.lines.map((l) => l.ruleId)).toEqual(['A'])
    expect(offer.skippedRules).toEqual(['B'])
  })
})

describe('purity', () => {
  it('does not mutate the cart or rules it is given', () => {
    const cartSnapshot = JSON.stringify(CART)
    const rulesSnapshot = JSON.stringify(RULES)
    calculate(CART, RULES)
    expect(JSON.stringify(CART)).toBe(cartSnapshot)
    expect(JSON.stringify(RULES)).toBe(rulesSnapshot)
  })

  it('returns identical output for identical input (re-runs are stable)', () => {
    expect(calculate(CART, RULES)).toEqual(calculate(CART, RULES))
  })
})

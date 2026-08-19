/**
 * largeCart.test.ts
 *
 * A wider dataset than the brief's: 15 rules × 30 items, covering combinations
 * the six-item sample never produces — two competing platform rules on one item,
 * two stackable rules on one item, and two cart rules qualifying at once.
 *
 * Each item is cross-checked against an INDEPENDENT reference implementation
 * written straight from the spec text, so the engine is not merely agreeing with
 * itself. This suite is what caught the cart-level stacking bug (RULE-13 was
 * qualifying but being dropped), and it exists to keep that fixed.
 */

import { describe, expect, it } from 'vitest'
import { calculate } from './discountEngine'
import { parseRulesCsv } from '../adapters/csv/csvRulesAdapter'
import type { CartItem, DiscountRule } from './types'
import { readFileSync } from 'node:fs'

const rulesCsv = readFileSync(new URL('../../sample-data/rules1.csv', import.meta.url), 'utf8')
const { data: rules, errors } = parseRulesCsv(rulesCsv)

const I = (itemId: string, product: string, brand: string, platform: string, basePrice: number): CartItem =>
  ({ itemId, product, brand, platform, basePrice })

const cart: CartItem[] = [
  I('ITEM-01', 'Cushion Cover', 'Natura Casa', 'Amazon India', 1299),
  I('ITEM-02', 'Bed Sheet Set', 'Natura Casa', 'Flipkart', 849),
  I('ITEM-03', 'Table Runner', 'Natura Casa', 'Noon', 599),
  I('ITEM-04', 'Curtain Panel', 'Natura Casa', 'Meesho', 1099),
  I('ITEM-05', 'Wall Shelf', 'LivSpace Pro', 'Amazon India', 599),
  I('ITEM-06', 'Floating Desk', 'LivSpace Pro', 'Flipkart', 3499),
  I('ITEM-07', 'Bookcase', 'LivSpace Pro', 'Myntra', 4299),
  I('ITEM-08', 'Ceramic Vase', 'LivSpace Pro', 'Noon', 2499),
  I('ITEM-09', 'Cutting Board', 'Nordic Basics', 'Amazon India', 449),
  I('ITEM-10', 'Desk Organiser', 'Nordic Basics', 'Flipkart', 899),
  I('ITEM-11', 'Storage Basket', 'Nordic Basics', 'Noon', 749),
  I('ITEM-12', 'Throw Blanket', 'Urban Loom', 'Amazon India', 1599),
  I('ITEM-13', 'Woven Rug', 'Urban Loom', 'Meesho', 2799),
  I('ITEM-14', 'Cushion Set', 'Urban Loom', 'Ajio', 1899),
  I('ITEM-15', 'Chef Knife', 'Terra Kitchen', 'Amazon India', 1249),
  I('ITEM-16', 'Spice Rack', 'Terra Kitchen', 'Flipkart', 699),
  I('ITEM-17', 'Ceramic Bowl Set', 'Terra Kitchen', 'Noon', 999),
  I('ITEM-18', 'Serving Tray', 'Terra Kitchen', 'Myntra', 899),
  I('ITEM-19', 'Scented Candle', 'Casa Bloom', 'Myntra', 549),
  I('ITEM-20', 'Vase Trio', 'Casa Bloom', 'Amazon India', 1349),
  I('ITEM-21', 'Wall Art Frame', 'Casa Bloom', 'Meesho', 799),
  I('ITEM-22', 'Bar Stool', 'Zenith Home', 'Flipkart', 4999),
  I('ITEM-23', 'Coffee Table', 'Zenith Home', 'Amazon India', 6499),
  I('ITEM-24', 'Accent Chair', 'Zenith Home', 'Noon', 8999),
  I('ITEM-25', 'Table Lamp', 'Lumen Co', 'Amazon India', 1799),
  I('ITEM-26', 'Floor Lamp', 'Lumen Co', 'Flipkart', 2299),
  I('ITEM-27', 'Picture Frame', 'Meadow Craft', 'Ajio', 399),
  I('ITEM-28', 'Plant Pot', 'Meadow Craft', 'Tata Cliq', 649),
  I('ITEM-29', 'Doormat', 'Pine & Oak', 'Ajio', 549),
  I('ITEM-30', 'Coat Rack', 'Pine & Oak', 'Amazon India', 1199),
]

// ── Independent reference implementation, written straight from the spec ──
function referenceItemPrice(item: CartItem, all: DiscountRule[]) {
  const matches = all.filter(
    (r) =>
      (r.scope === 'brand' && r.appliesTo === item.brand) ||
      (r.scope === 'platform' && r.appliesTo === item.platform)
  )
  const amount = (price: number, r: DiscountRule) =>
    r.type === 'percentage' ? Math.round((price * r.value) / 100) : Math.min(r.value, price)

  const ns = matches.filter((r) => !r.stackable)
  const st = matches.filter((r) => r.stackable)

  let price = item.basePrice
  const applied: string[] = []

  if (ns.length) {
    // spec: largest rupee saving wins, scope irrelevant
    const winner = ns.reduce((b, r) =>
      amount(item.basePrice, r) > amount(item.basePrice, b) ? r : b
    )
    price -= amount(price, winner)
    applied.push(winner.ruleId)
  }
  for (const r of st) {
    price -= amount(price, r)
    applied.push(r.ruleId)
  }
  return { price: Math.round(price), applied, matchCount: matches.length }
}

describe('30-item cart audit vs independent reference', () => {
  it('parses rules1.csv cleanly', () => {
    expect(errors).toEqual([])
    expect(rules).toHaveLength(15)
  })

  const result = calculate(cart, rules)
  const itemRules = rules.filter((r) => r.scope !== 'cart')

  it('every item matches the reference implementation', () => {
    const mismatches: string[] = []
    for (const [i, item] of cart.entries()) {
      const ref = referenceItemPrice(item, itemRules)
      const got = result.items[i]!
      if (got.finalPrice !== ref.price || got.appliedRules.join() !== ref.applied.join()) {
        mismatches.push(
          `${item.itemId}: engine=${got.finalPrice} [${got.appliedRules}] ref=${ref.price} [${ref.applied}]`
        )
      }
    }
    expect(mismatches).toEqual([])
  })

  it('no rule that matched an item was silently dropped', () => {
    // Every matching rule must appear in appliedRules OR skippedRules.
    const unaccounted: string[] = []
    for (const [i, item] of cart.entries()) {
      const matches = itemRules.filter(
        (r) =>
          (r.scope === 'brand' && r.appliesTo === item.brand) ||
          (r.scope === 'platform' && r.appliesTo === item.platform)
      )
      const got = result.items[i]!
      const accounted = new Set([...got.appliedRules, ...got.skippedRules])
      for (const r of matches) {
        if (!accounted.has(r.ruleId)) unaccounted.push(`${item.itemId} lost ${r.ruleId}`)
      }
      // And every stackable match MUST be applied, never skipped.
      for (const r of matches.filter((r) => r.stackable)) {
        if (!got.appliedRules.includes(r.ruleId)) {
          unaccounted.push(`${item.itemId} dropped stackable ${r.ruleId}`)
        }
      }
    }
    expect(unaccounted).toEqual([])
  })

  it('applies Rs.9,120 of item-level discounts across the cart', () => {
    const itemSavings = result.items.reduce((s, r) => s + r.totalDiscount, 0)
    expect(cart.reduce((s, r) => s + r.basePrice, 0)).toBe(57070)
    expect(itemSavings).toBe(9120)
    expect(result.subtotal).toBe(47950)
  })

  it('stacks both qualifying cart rules as separate lines', () => {
    expect(result.cartOffer.lines.map((l) => [l.ruleId, l.amountSaved])).toEqual([
      ['RULE-04', 4795], // 10% of 47,950 — non-stackable winner
      ['RULE-13', 2158], // 5% of the remaining 43,155 — stacked on top
    ])
    expect(result.cartOffer.totalSaved).toBe(6953)
  })

  it('lands on a Rs.40,997 final total', () => {
    expect(result.finalTotal).toBe(40997)
    expect(result.totalSaved).toBe(16073)
  })

  it('leaves items with no matching rule at base price', () => {
    // Ajio / Tata Cliq platforms and Meadow Craft / Pine & Oak brands are unruled.
    const noOffer = result.items.filter((i) => i.appliedRules.length === 0)
    expect(noOffer.map((i) => i.itemId)).toEqual(['ITEM-27', 'ITEM-28', 'ITEM-29'])
    for (const item of noOffer) {
      expect(item.finalPrice).toBe(item.basePrice)
      expect(item.reasoning).toBe('No offers available')
    }
  })
})

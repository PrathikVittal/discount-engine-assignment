/**
 * adapters.test.ts
 *
 * Adapters are the only place malformed input can enter the system, so these
 * tests focus on the failure paths the brief calls out as judgment calls:
 * a bad row must be reported and skipped, never crash and never silently pass
 * through to the engine.
 *
 * The PDF adapter isn't covered here — it needs a real browser (pdf.js worker,
 * File API); it's verified against `sample-data/sample-cart*.pdf` in the app.
 */

import { describe, expect, it } from 'vitest'
import { parseCartCsv } from './csv/csvCartAdapter'
import { parseRulesCsv } from './csv/csvRulesAdapter'
import { parseAdditionalCartDiscount } from './llm/llmRuleAdapter'
import { parsedRuleSchema, toDiscountRule } from '../engine/ruleSchema'

describe('csvRulesAdapter', () => {
  it('parses the four sample rules, cart rule included', () => {
    const { data, errors } = parseRulesCsv(
      [
        'rule_id,scope,applies_to,type,value,stackable,min_cart_value',
        'RULE-01,platform,Amazon India,percentage,15,false,',
        'RULE-02,brand,Natura Casa,flat,150,false,',
        'RULE-03,platform,Flipkart,percentage,10,true,',
        'RULE-04,cart,,percentage,10,false,4000',
      ].join('\n')
    )

    expect(errors).toEqual([])
    expect(data).toHaveLength(4)
    expect(data[3]).toEqual({
      ruleId: 'RULE-04',
      scope: 'cart',
      appliesTo: null,
      type: 'percentage',
      value: 10,
      stackable: false,
      minCartValue: 4000,
    })
    expect(data[2]!.stackable).toBe(true)
  })

  it('treats a cart rule with a blank threshold as unconditional', () => {
    const { data, errors } = parseRulesCsv(
      'rule_id,scope,applies_to,type,value,stackable,min_cart_value\nRULE-09,cart,,percentage,10,false,'
    )
    expect(errors).toEqual([])
    expect(data[0]!.minCartValue).toBeUndefined()
  })

  it('still rejects a malformed threshold', () => {
    const { data, errors } = parseRulesCsv(
      'rule_id,scope,applies_to,type,value,stackable,min_cart_value\nRULE-09,cart,,percentage,10,false,soon'
    )
    expect(data).toHaveLength(0)
    expect(errors[0]).toMatch(/min_cart_value/)
  })

  it('keeps the good rows when one row is bad', () => {
    const { data, errors } = parseRulesCsv(
      [
        'rule_id,scope,applies_to,type,value,stackable,min_cart_value',
        'RULE-01,platform,Amazon India,percentage,15,false,',
        'RULE-02,galaxy,Natura Casa,flat,150,false,',
        'RULE-03,platform,Flipkart,percentage,10,true,',
      ].join('\n')
    )
    expect(data.map((r) => r.ruleId)).toEqual(['RULE-01', 'RULE-03'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/Row 3/)
  })

  it('refuses a percentage over 100', () => {
    const { data, errors } = parseRulesCsv(
      'rule_id,scope,applies_to,type,value,stackable,min_cart_value\nR,platform,Noon,percentage,150,false,'
    )
    expect(data).toHaveLength(0)
    expect(errors[0]).toMatch(/cannot exceed 100/)
  })
})

describe('csvCartAdapter', () => {
  it('parses the sample cart', () => {
    const { data, errors } = parseCartCsv(
      'item_id,product,brand,platform,base_price\nITEM-01,Cushion Cover,Natura Casa,Amazon India,1299'
    )
    expect(errors).toEqual([])
    expect(data[0]).toEqual({
      itemId: 'ITEM-01',
      product: 'Cushion Cover',
      brand: 'Natura Casa',
      platform: 'Amazon India',
      basePrice: 1299,
    })
  })

  it('reports a bad price and keeps the rest of the cart', () => {
    const { data, errors } = parseCartCsv(
      [
        'item_id,product,brand,platform,base_price',
        'ITEM-01,Cushion Cover,Natura Casa,Amazon India,1299',
        'ITEM-02,Bed Sheet Set,Natura Casa,Flipkart,free',
        'ITEM-03,Wall Shelf,LivSpace Pro,Amazon India,599',
      ].join('\n')
    )
    expect(data.map((i) => i.itemId)).toEqual(['ITEM-01', 'ITEM-03'])
    expect(errors[0]).toMatch(/base_price/)
  })

  it('accepts a price written with separators', () => {
    const { data } = parseCartCsv(
      'item_id,product,brand,platform,base_price\nITEM-01,Vase,LivSpace Pro,Noon,"2,499"'
    )
    expect(data[0]!.basePrice).toBe(2499)
  })
})

/**
 * These cover the "what if the LLM returns something invalid" case without
 * needing a live model — the schema is the thing standing between a bad parse
 * and the cart, so it's tested directly.
 */
describe('parsedRuleSchema — the guard on LLM output', () => {
  const valid = {
    scope: 'brand' as const,
    appliesTo: 'Natura Casa',
    type: 'percentage' as const,
    value: 20,
    stackable: true,
  }

  it('accepts a well-formed rule and gives it an id', () => {
    const parsed = parsedRuleSchema.parse(valid)
    expect(toDiscountRule(parsed, 'RULE-05')).toEqual({ ...valid, ruleId: 'RULE-05' })
  })

  it('accepts an unconditional cart rule — "20% off the whole cart"', () => {
    const result = parsedRuleSchema.safeParse({
      scope: 'cart',
      appliesTo: null,
      type: 'percentage',
      value: 20,
      stackable: false,
    })
    expect(result.success).toBe(true)
    expect(result.data?.minCartValue).toBeUndefined()
  })

  it('rejects a brand rule that names no brand', () => {
    expect(parsedRuleSchema.safeParse({ ...valid, appliesTo: null }).success).toBe(false)
  })

  it('rejects a missing or zero discount value', () => {
    expect(parsedRuleSchema.safeParse({ ...valid, value: 0 }).success).toBe(false)
    expect(parsedRuleSchema.safeParse({ ...valid, value: null }).success).toBe(false)
  })

  it('rejects a percentage over 100', () => {
    expect(parsedRuleSchema.safeParse({ ...valid, value: 150 }).success).toBe(false)
  })

  it('drops appliesTo for cart rules so it can never match an item', () => {
    const parsed = parsedRuleSchema.parse({
      scope: 'cart',
      appliesTo: null,
      type: 'percentage',
      value: 10,
      stackable: false,
      minCartValue: 5000,
    })
    expect(toDiscountRule(parsed, 'RULE-05').appliesTo).toBeNull()
  })
})

describe('additional cart discount wording', () => {
  it('turns an additional whole-discount percentage into a stacked cart rule', () => {
    const outcome = parseAdditionalCartDiscount(
      'Additional 20% off whole discount stackable! Used after the entire discount applied.',
      'RULE-05'
    )

    expect(outcome).toEqual({
      status: 'parsed',
      parsed: {
        scope: 'cart',
        appliesTo: null,
        type: 'percentage',
        value: 20,
        stackable: true,
      },
      rule: {
        ruleId: 'RULE-05',
        scope: 'cart',
        appliesTo: null,
        type: 'percentage',
        value: 20,
        stackable: true,
      },
    })
  })

  it('does not reinterpret a general percentage offer as an additional cart discount', () => {
    expect(parseAdditionalCartDiscount('20% off on Flipkart', 'RULE-05')).toBeNull()
  })
})

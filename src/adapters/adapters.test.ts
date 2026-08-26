/**
 * adapters.test.ts
 *
 * Adapters are the only place malformed input can enter the system, so these
 * tests focus on the failure paths the brief calls out as judgment calls:
 * a bad row must be reported and skipped, never crash and never silently pass
 * through to the engine.
 *
 * The PDF, XLSX and DOCX adapters aren't covered here — each needs a real
 * browser (pdf.js worker, File API, DOMParser); they're verified against the
 * files in `sample-data/` in the app.
 *
 * What they all share *is* covered: every one of them reduces its input to a
 * table and hands it to `tableToCart`, which holds the column matching, price
 * parsing and row validation. Testing it directly covers the logic that would
 * otherwise be untested in three separate browser-only adapters.
 */

import { describe, expect, it } from 'vitest'
import { parseCartCsv } from './csv/csvCartAdapter'
import { parseRulesCsv } from './csv/csvRulesAdapter'
import { parseAdditionalCartDiscount } from './llm/llmRuleAdapter'
import { parsedRuleSchema, toDiscountRule } from '../engine/ruleSchema'
import { tableToCart } from './table/tableToCart'

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


describe('tableToCart — the shared PDF / XLSX / DOCX mapper', () => {
  const header = ['Product', 'Brand', 'Platform', 'Base Price']
  const sample = [
    header,
    ['Cushion Cover', 'Natura Casa', 'Amazon India', 'Rs.1,299'],
    ['Bed Sheet Set', 'Natura Casa', 'Flipkart', 'Rs.849'],
    ['Wall Shelf', 'LivSpace Pro', 'Amazon India', 'Rs.599'],
    ['Ceramic Vase', 'LivSpace Pro', 'Noon', 'Rs.2,499'],
    ['Cutting Board', 'Nordic Basics', 'Amazon India', 'Rs.449'],
    ['Desk Organiser', 'Nordic Basics', 'Flipkart', 'Rs.899'],
  ]

  it('maps the brief’s six-item table', () => {
    const { data, errors } = tableToCart(sample)

    expect(errors).toEqual([])
    expect(data).toHaveLength(6)
    expect(data[0]).toEqual({
      itemId: 'ITEM-01',
      product: 'Cushion Cover',
      brand: 'Natura Casa',
      platform: 'Amazon India',
      basePrice: 1299,
    })
    expect(data.map((item) => item.basePrice)).toEqual([1299, 849, 599, 2499, 449, 899])
  })

  it('assigns item ids in reading order, since none of these formats carry one', () => {
    const { data } = tableToCart(sample)
    expect(data.map((item) => item.itemId)).toEqual([
      'ITEM-01', 'ITEM-02', 'ITEM-03', 'ITEM-04', 'ITEM-05', 'ITEM-06',
    ])
  })

  it('continues numbering from startIndex, so page 2 does not restart at ITEM-01', () => {
    const { data } = tableToCart(sample, { startIndex: 6 })
    expect(data[0]!.itemId).toBe('ITEM-07')
    expect(data[5]!.itemId).toBe('ITEM-12')
  })

  it('accepts header synonyms — Item / Marketplace / Amount', () => {
    const { data, errors } = tableToCart([
      ['Item', 'Brand', 'Marketplace', 'Amount'],
      ['Wall Shelf', 'LivSpace Pro', 'Amazon India', '599'],
    ])

    expect(errors).toEqual([])
    expect(data[0]).toMatchObject({ product: 'Wall Shelf', platform: 'Amazon India', basePrice: 599 })
  })

  it('reads columns by position, not by guessing at each value', () => {
    // "Noon" in the brand column is a platform name — position must still win.
    const { data } = tableToCart([header, ['Vase', 'Noon', 'Flipkart', '100']])
    expect(data[0]).toMatchObject({ brand: 'Noon', platform: 'Flipkart' })
  })

  it('handles Rs. / ₹ / thousands separators / decimals', () => {
    const { data } = tableToCart([
      header,
      ['A', 'B', 'C', 'Rs.1,299'],
      ['D', 'E', 'F', '₹849'],
      ['G', 'H', 'I', '1,299.00'],
      ['J', 'K', 'L', '599'],
    ])
    expect(data.map((item) => item.basePrice)).toEqual([1299, 849, 1299, 599])
  })

  it('names a row with a missing column and keeps the rest of the cart', () => {
    const { data, errors } = tableToCart([
      header,
      ['Cushion Cover', 'Natura Casa', 'Amazon India', 'Rs.1,299'],
      ['Bed Sheet Set', 'Natura Casa', '', 'Rs.849'],
      ['Wall Shelf', 'LivSpace Pro', 'Amazon India', 'Rs.599'],
    ])

    expect(data).toHaveLength(2)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('missing platform')
    expect(errors[0]).toContain('Bed Sheet Set')
    // The survivors renumber contiguously rather than leaving a gap.
    expect(data.map((item) => item.itemId)).toEqual(['ITEM-01', 'ITEM-02'])
  })

  it('names a row whose price cannot be read and keeps the rest', () => {
    const { data, errors } = tableToCart([
      header,
      ['Cushion Cover', 'Natura Casa', 'Amazon India', 'Rs.TBD'],
      ['Wall Shelf', 'LivSpace Pro', 'Amazon India', 'Rs.599'],
    ])

    expect(data).toHaveLength(1)
    expect(errors[0]).toContain("isn't a valid price")
    expect(errors[0]).toContain('Rs.TBD')
  })

  it('rejects a zero or negative price rather than pricing an item at nothing', () => {
    const { data, errors } = tableToCart([header, ['A', 'B', 'C', '0']])
    expect(data).toEqual([])
    expect(errors[0]).toContain("isn't a valid price")
  })

  it('drops dividers, order metadata and total rows', () => {
    const { data, errors } = tableToCart([
      ['Order #OP-9921', '', '', ''],
      header,
      ['──────', '──────', '──────', '──────'],
      ['Cushion Cover', 'Natura Casa', 'Amazon India', 'Rs.1,299'],
      ['', '', '', ''],
      ['Total', '', '', 'Rs.1,299'],
    ])

    expect(data).toHaveLength(1)
    expect(errors).toEqual([])
  })

  it('reports a table with no recognisable header instead of guessing', () => {
    const { data, errors } = tableToCart([
      ['Cushion Cover', 'Natura Casa', 'Amazon India', 'Rs.1,299'],
    ])

    expect(data).toEqual([])
    expect(errors[0]).toContain('No item table found')
    expect(errors[0]).toContain('Product, Brand, Platform, Base Price')
  })

  it('says where a row came from when the caller provides context', () => {
    const { errors } = tableToCart([header, ['A', 'B', 'C', 'nope']], {
      where: ' (sheet "Cart")',
    })
    expect(errors[0]).toContain('(sheet "Cart")')
  })

  it('tolerates short rows without throwing', () => {
    const { data, errors } = tableToCart([header, ['Cushion Cover', 'Natura Casa']])
    expect(data).toEqual([])
    expect(errors[0]).toContain('missing')
  })
})

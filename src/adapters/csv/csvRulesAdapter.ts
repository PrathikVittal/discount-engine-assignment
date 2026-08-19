/**
 * csvRulesAdapter.ts
 *
 * INPUT ADAPTER — rules.csv → DiscountRule[]
 *
 * Knows about CSV columns and nothing about how discounts are calculated.
 * A bad row is reported and skipped; the remaining rows still load.
 *
 * Expected columns: rule_id, scope, applies_to, type, value, stackable, min_cart_value
 * (`min_cart_value` is required for cart-scoped rules and ignored otherwise.)
 */

import Papa from 'papaparse'
import type { AdapterResult, DiscountRule, RuleScope, RuleType } from '../../engine/types'

const SCOPES: RuleScope[] = ['brand', 'platform', 'cart']
const TYPES: RuleType[] = ['percentage', 'flat']

type Row = Record<string, string | undefined>

const TRUTHY = new Set(['true', '1', 'yes', 'y'])

export function parseRulesCsv(csvText: string): AdapterResult<DiscountRule> {
  const { data: rows, errors: papaErrors } = Papa.parse<Row>(csvText.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
  })

  if (papaErrors.length > 0) {
    return { data: [], errors: papaErrors.map((e) => `CSV error: ${e.message}`) }
  }

  const data: DiscountRule[] = []
  const errors: string[] = []

  rows.forEach((row, i) => {
    const line = i + 2 // +1 for the header, +1 for 1-based numbering
    const fail = (msg: string) => errors.push(`Row ${line}: ${msg}`)

    const ruleId = row.rule_id?.trim()
    const rawScope = row.scope?.trim().toLowerCase()
    const rawType = row.type?.trim().toLowerCase()
    const rawValue = row.value?.trim()

    if (!ruleId) return fail('missing rule_id')
    if (!rawScope) return fail('missing scope')
    if (!rawType) return fail('missing type')
    if (!rawValue) return fail('missing value')

    if (!SCOPES.includes(rawScope as RuleScope)) {
      return fail(`scope must be one of ${SCOPES.join(' / ')}, got "${row.scope}"`)
    }
    if (!TYPES.includes(rawType as RuleType)) {
      return fail(`type must be one of ${TYPES.join(' / ')}, got "${row.type}"`)
    }

    const scope = rawScope as RuleScope
    const type = rawType as RuleType

    const value = Number(rawValue)
    if (!Number.isFinite(value) || value <= 0) {
      return fail(`value must be a positive number, got "${rawValue}"`)
    }
    if (type === 'percentage' && value > 100) {
      return fail(`a percentage discount cannot exceed 100%, got "${rawValue}"`)
    }

    const appliesTo = row.applies_to?.trim() || null
    if (scope !== 'cart' && !appliesTo) {
      return fail(`a ${scope} rule needs applies_to to name the ${scope}`)
    }

    // A threshold is optional: a cart rule with a blank min_cart_value is an
    // unconditional offer that applies to every cart. Only a *malformed* value
    // is an error. (The rules table renders these as "Always" so an accidental
    // blank is visible rather than silently permissive.)
    let minCartValue: number | undefined
    const rawMin = row.min_cart_value?.trim()
    if (scope === 'cart' && rawMin) {
      minCartValue = Number(rawMin)
      if (!Number.isFinite(minCartValue) || minCartValue <= 0) {
        return fail(`min_cart_value must be a positive number, got "${rawMin}"`)
      }
    }

    data.push({
      ruleId,
      scope,
      appliesTo: scope === 'cart' ? null : appliesTo,
      type,
      value,
      stackable: TRUTHY.has((row.stackable ?? '').trim().toLowerCase()),
      ...(minCartValue !== undefined ? { minCartValue } : {}),
    })
  })

  if (data.length === 0 && errors.length === 0) {
    errors.push('No rules found in this file.')
  }

  return { data, errors }
}

/**
 * csvCartAdapter.ts
 *
 * INPUT ADAPTER — cart.csv → CartItem[]
 *
 * Expected columns: item_id, product, brand, platform, base_price
 */

import Papa from 'papaparse'
import type { AdapterResult, CartItem } from '../../engine/types'

type Row = Record<string, string | undefined>

export function parseCartCsv(csvText: string): AdapterResult<CartItem> {
  const { data: rows, errors: papaErrors } = Papa.parse<Row>(csvText.trim(), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, '_'),
  })

  if (papaErrors.length > 0) {
    return { data: [], errors: papaErrors.map((e) => `CSV error: ${e.message}`) }
  }

  const data: CartItem[] = []
  const errors: string[] = []

  rows.forEach((row, i) => {
    const line = i + 2
    const fail = (msg: string) => errors.push(`Row ${line}: ${msg}`)

    const itemId = row.item_id?.trim()
    const product = row.product?.trim()
    const brand = row.brand?.trim()
    const platform = row.platform?.trim()
    const rawPrice = row.base_price?.trim()

    const missing = [
      !itemId && 'item_id',
      !product && 'product',
      !brand && 'brand',
      !platform && 'platform',
      !rawPrice && 'base_price',
    ].filter(Boolean)

    if (missing.length > 0) return fail(`missing ${missing.join(', ')}`)

    const basePrice = Number(rawPrice!.replace(/[,\s₹]/g, ''))
    if (!Number.isFinite(basePrice) || basePrice <= 0) {
      return fail(`base_price must be a positive number, got "${rawPrice}"`)
    }

    data.push({
      itemId: itemId!,
      product: product!,
      brand: brand!,
      platform: platform!,
      basePrice: Math.round(basePrice),
    })
  })

  if (data.length === 0 && errors.length === 0) {
    errors.push('No cart items found in this file.')
  }

  return { data, errors }
}

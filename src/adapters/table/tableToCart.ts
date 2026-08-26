/**
 * tableToCart.ts
 *
 * SHARED TABLE MAPPER — rows of cells → CartItem[]
 *
 * Three input formats all end up as a header row plus data rows: a PDF (after
 * its glyphs are clustered back into lines), a spreadsheet, and a Word table.
 * Only the *extraction* differs between them; the interpretation — which column
 * is which, what counts as a price, which lines are noise — is identical.
 *
 * So that interpretation lives here, once. Each adapter's job is reduced to
 * "produce string[][]", and every format inherits the same column aliases, the
 * same price handling, and the same per-row error wording for free.
 *
 * Pure and DOM-free, which is what lets it carry the test coverage for input
 * paths whose own adapters need a browser to run.
 */

import type { AdapterResult, CartItem } from '../../engine/types'

export const COLUMNS = ['product', 'brand', 'platform', 'price'] as const
export type Column = (typeof COLUMNS)[number]

/** Header labels accepted for each column, lowercased. */
export const HEADER_ALIASES: Record<Column, string[]> = {
  product: ['product', 'item', 'description'],
  brand: ['brand'],
  platform: ['platform', 'marketplace', 'channel'],
  price: ['base price', 'price', 'amount', 'mrp'],
}

/** "Rs.1,299" / "₹1299" / "1,299.00" → 1299 */
export function parsePrice(raw: string): number | null {
  const digits = raw.replace(/(rs\.?|inr|₹)/gi, '').replace(/[,\s]/g, '')
  if (!/^\d+(\.\d+)?$/.test(digits)) return null
  const value = Number(digits)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

/** Rows that are decoration, metadata or totals rather than cart items. */
function isNoiseRow(cells: Record<Column, string>, joined: string): boolean {
  if (/^[\s─—–_=|+.-]*$/.test(joined)) return true // rule/divider lines
  if (/^(order|date|invoice|total|subtotal|grand total|qty|page)\b/i.test(joined.trim())) return true
  return !cells.product && !cells.brand && !cells.platform
}

/**
 * Locates the header row and maps each column to its position.
 *
 * Position-based rather than alias-per-cell: once we know "Brand" is column 1,
 * every later row's cell 1 is a brand, even when the value itself looks like
 * something else. Returns null when no row reads as a header.
 */
function findHeader(rows: string[][]): { index: number; positions: Map<Column, number> } | null {
  for (const [index, row] of rows.entries()) {
    const cells = row.map((cell) => cell.trim().toLowerCase())
    const joined = cells.join(' ')

    const looksLikeHeader =
      joined.includes('product') || joined.includes('item') || joined.includes('description')
    if (!looksLikeHeader) continue

    const positions = new Map<Column, number>()
    for (const column of COLUMNS) {
      const at = cells.findIndex((cell) =>
        HEADER_ALIASES[column].some((alias) => cell === alias || cell.startsWith(alias))
      )
      if (at !== -1) positions.set(column, at)
    }

    if (positions.size === COLUMNS.length) return { index, positions }
  }

  return null
}

export interface TableToCartOptions {
  /** Appended to row errors to say where the row came from, e.g. " (page 2)". */
  where?: string
  /** Item ids continue from here — lets a multi-page/multi-sheet source keep numbering. */
  startIndex?: number
}

/**
 * Maps a table of cells to cart items.
 *
 * A row that can't be read is reported by name and skipped; it never costs the
 * user the rest of their cart. Item ids are assigned in reading order because
 * none of these formats carry one.
 */
export function tableToCart(
  rows: string[][],
  options: TableToCartOptions = {}
): AdapterResult<CartItem> {
  const { where = '', startIndex = 0 } = options

  const header = findHeader(rows)
  if (!header) {
    return {
      data: [],
      errors: [
        `No item table found${where}. Expected columns: Product, Brand, Platform, Base Price.`,
      ],
    }
  }

  const data: CartItem[] = []
  const errors: string[] = []

  const cellAt = (row: string[], column: Column) =>
    (row[header.positions.get(column)!] ?? '').trim()

  for (const row of rows.slice(header.index + 1)) {
    const cells: Record<Column, string> = {
      product: cellAt(row, 'product'),
      brand: cellAt(row, 'brand'),
      platform: cellAt(row, 'platform'),
      price: cellAt(row, 'price'),
    }

    const joined = row.map((cell) => cell.trim()).filter(Boolean).join(' ')
    if (isNoiseRow(cells, joined)) continue

    const missing = COLUMNS.filter((column) => !cells[column])
    if (missing.length > 0) {
      errors.push(`Skipped "${joined}"${where} — missing ${missing.join(', ')}.`)
      continue
    }

    const basePrice = parsePrice(cells.price)
    if (basePrice === null) {
      errors.push(`Skipped "${joined}"${where} — "${cells.price}" isn't a valid price.`)
      continue
    }

    data.push({
      itemId: `ITEM-${String(startIndex + data.length + 1).padStart(2, '0')}`,
      product: cells.product,
      brand: cells.brand,
      platform: cells.platform,
      basePrice,
    })
  }

  return { data, errors }
}

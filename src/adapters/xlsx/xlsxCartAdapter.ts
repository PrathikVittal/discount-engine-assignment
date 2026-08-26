/**
 * xlsxCartAdapter.ts
 *
 * INPUT ADAPTER — cart .xlsx → CartItem[]
 *
 * Runs entirely in the browser; no server involved.
 *
 * A spreadsheet is the easy case of the three table formats: rows and columns
 * genuinely exist, so there is no reconstruction to do. All this adapter does is
 * read the first sheet into a grid of strings and hand it to the shared mapper,
 * which then applies exactly the same column aliases, price handling and
 * per-row error wording that the PDF and Word paths get.
 *
 * SheetJS is ~1MB, so it is imported on demand — a user who only ever uploads
 * CSV never downloads it.
 */

import type { AdapterResult, CartItem } from '../../engine/types'
import { tableToCart } from '../table/tableToCart'

export async function parseCartXlsx(file: File): Promise<AdapterResult<CartItem>> {
  let rows: string[][]
  let sheetName: string

  try {
    const XLSX = await import('xlsx')
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' })

    // First sheet only. A workbook with the cart split across sheets is a real
    // possibility, but picking between them needs UI we don't have — so the
    // rule is stated rather than guessed at.
    const first = workbook.SheetNames[0]
    if (!first) {
      return { data: [], errors: [`"${file.name}" has no sheets.`] }
    }
    sheetName = first

    rows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets[first]!, {
      header: 1, // a grid of cells, not objects keyed by header
      blankrows: false,
      raw: false, // formatted text, so "Rs.1,299" survives for parsePrice
      defval: '',
    })
  } catch {
    return {
      data: [],
      errors: [`Couldn't read "${file.name}" — it may be corrupted or not a real .xlsx file.`],
    }
  }

  // Cells can come back as non-strings despite `raw: false` (dates, booleans);
  // normalise before the mapper, which expects text.
  const table = rows.map((row) => Array.from(row ?? [], (cell) => String(cell ?? '')))

  const where = rows.length > 0 ? ` (sheet "${sheetName}")` : ''
  return tableToCart(table, { where })
}

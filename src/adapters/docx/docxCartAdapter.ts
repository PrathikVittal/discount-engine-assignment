/**
 * docxCartAdapter.ts
 *
 * INPUT ADAPTER — cart .docx → CartItem[]
 *
 * Runs entirely in the browser; no server involved.
 *
 * A .docx is a zip of XML. Rather than walk that XML directly, mammoth converts
 * the document to HTML — which preserves <table>/<tr>/<td> structure — and the
 * first table is read off as a grid. `extractRawText` would be simpler but is
 * unusable here: it flattens tables into prose and loses the column boundaries
 * that make the row meaningful.
 *
 * Interpretation is then the shared mapper's job, so Word inherits the same
 * column aliases, price formats and error wording as the other table formats.
 *
 * mammoth is imported on demand for the same reason as pdf.js and SheetJS.
 */

import type { AdapterResult, CartItem } from '../../engine/types'
import { tableToCart } from '../table/tableToCart'

/** Reads an HTML <table> into a grid of trimmed cell text. */
function tableToRows(table: HTMLTableElement): string[][] {
  return Array.from(table.rows, (row) =>
    Array.from(row.cells, (cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim())
  )
}

export async function parseCartDocx(file: File): Promise<AdapterResult<CartItem>> {
  let html: string

  try {
    const mammoth = await import('mammoth')
    const result = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() })
    html = result.value
  } catch {
    return {
      data: [],
      errors: [`Couldn't read "${file.name}" — it may be corrupted or not a real .docx file.`],
    }
  }

  const doc = new DOMParser().parseFromString(html, 'text/html')
  const tables = Array.from(doc.querySelectorAll('table'))

  if (tables.length === 0) {
    return {
      data: [],
      errors: [
        `No item table found in "${file.name}". Expected a table with columns: Product, Brand, Platform, Base Price.`,
      ],
    }
  }

  // Documents often open with a letterhead or summary table, so take the first
  // table that actually maps to cart items rather than assuming it's table one.
  let lastErrors: string[] = []
  for (const table of tables) {
    const result = tableToCart(tableToRows(table))
    if (result.data.length > 0) return result
    lastErrors = result.errors
  }

  return { data: [], errors: lastErrors }
}

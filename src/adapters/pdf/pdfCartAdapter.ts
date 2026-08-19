/**
 * pdfCartAdapter.ts
 *
 * INPUT ADAPTER — cart PDF → CartItem[]
 *
 * Runs entirely in the browser (pdf.js); no server involved.
 *
 * A PDF has no rows or columns — only glyphs at coordinates. So the table is
 * rebuilt in two steps:
 *   1. Group text runs into visual lines by their y coordinate.
 *   2. Read the header line ("Product  Brand  Platform  Base Price") to learn
 *      each column's x position, then assign every run on later lines to the
 *      nearest column.
 *
 * Reading columns from the header rather than splitting on whitespace is what
 * makes multi-word values ("Natura Casa", "Amazon India") survive intact.
 *
 * A row that can't be read is reported and skipped — one bad line never costs
 * the user the rest of their cart.
 */

import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { AdapterResult, CartItem } from '../../engine/types'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

interface TextRun {
  text: string
  x: number
  y: number
}

/** Text runs whose baselines are within this many points count as one line. */
const LINE_TOLERANCE = 3

const COLUMNS = ['product', 'brand', 'platform', 'price'] as const
type Column = (typeof COLUMNS)[number]

/** Header labels we accept for each column, lowercased. */
const HEADER_ALIASES: Record<Column, string[]> = {
  product: ['product', 'item', 'description'],
  brand: ['brand'],
  platform: ['platform', 'marketplace', 'channel'],
  price: ['base price', 'price', 'amount', 'mrp'],
}

async function extractRuns(file: File): Promise<TextRun[][]> {
  const loadingTask = pdfjs.getDocument({ data: await file.arrayBuffer() })
  const pages: TextRun[][] = []

  try {
    const doc = await loadingTask.promise

    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo)
      const content = await page.getTextContent()

      const runs: TextRun[] = content.items
        .filter((item): item is Extract<typeof item, { str: string }> => 'str' in item)
        .filter((item) => item.str.trim().length > 0)
        .map((item) => ({
          text: item.str.trim(),
          // transform = [a, b, c, d, e, f]; e/f are the x/y translation.
          x: item.transform[4] as number,
          y: item.transform[5] as number,
        }))

      pages.push(runs)
    }
  } finally {
    // `destroy()` lives on the loading task, not the document proxy — this also
    // tears down the pdf.js worker so repeated uploads don't leak one each time.
    await loadingTask.destroy()
  }

  return pages
}

/** Groups runs into visual lines, top of page first, each ordered left to right. */
function groupIntoLines(runs: TextRun[]): TextRun[][] {
  const lines: TextRun[][] = []

  for (const run of [...runs].sort((a, b) => b.y - a.y)) {
    const line = lines.find((candidate) => Math.abs(candidate[0]!.y - run.y) <= LINE_TOLERANCE)
    if (line) line.push(run)
    else lines.push([run])
  }

  return lines.map((line) => line.sort((a, b) => a.x - b.x))
}

/** Finds the header line and returns each column's x position. */
function findColumnAnchors(lines: TextRun[][]): { anchors: Map<Column, number>; index: number } | null {
  for (const [index, line] of lines.entries()) {
    const joined = line.map((run) => run.text.toLowerCase()).join(' ')
    const looksLikeHeader =
      joined.includes('product') && joined.includes('brand') && joined.includes('platform')
    if (!looksLikeHeader) continue

    const anchors = new Map<Column, number>()
    for (const column of COLUMNS) {
      // "Base Price" may arrive as one run or as "Base" + "Price"; match the
      // start of the label so either way we anchor on the same x.
      const match = line.find((run) =>
        HEADER_ALIASES[column].some((alias) => {
          const text = run.text.toLowerCase()
          return text === alias || alias.startsWith(text) || text.startsWith(alias)
        })
      )
      if (match) anchors.set(column, match.x)
    }

    if (anchors.size === COLUMNS.length) return { anchors, index }
  }

  return null
}

/** Assigns each run on a line to the column whose anchor it sits closest to. */
function splitByColumns(line: TextRun[], anchors: Map<Column, number>): Record<Column, string> {
  const buckets: Record<Column, string[]> = { product: [], brand: [], platform: [], price: [] }

  for (const run of line) {
    let best: Column = 'product'
    let bestDistance = Infinity
    for (const [column, x] of anchors) {
      // Bias to the column the run starts at or after — text is left-aligned
      // under its header, so a run slightly right of an anchor belongs to it.
      const distance = run.x >= x - 2 ? run.x - x : (x - run.x) * 3
      if (distance < bestDistance) {
        bestDistance = distance
        best = column
      }
    }
    buckets[best].push(run.text)
  }

  return {
    product: buckets.product.join(' ').trim(),
    brand: buckets.brand.join(' ').trim(),
    platform: buckets.platform.join(' ').trim(),
    price: buckets.price.join(' ').trim(),
  }
}

/** "Rs.1,299" / "₹1299" / "1,299.00" → 1299 */
function parsePrice(raw: string): number | null {
  const digits = raw.replace(/(rs\.?|inr|₹)/gi, '').replace(/[,\s]/g, '')
  if (!/^\d+(\.\d+)?$/.test(digits)) return null
  const value = Number(digits)
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null
}

/** Lines that are decoration or totals rather than cart items. */
function isNoiseLine(cells: Record<Column, string>, joined: string): boolean {
  if (/^[\s─—–_=|+.-]*$/.test(joined)) return true // rule/divider lines
  if (/^(order|date|invoice|total|subtotal|grand total|qty|page)\b/i.test(joined.trim())) return true
  return !cells.product && !cells.brand && !cells.platform
}

export async function parseCartPdf(file: File): Promise<AdapterResult<CartItem>> {
  let pages: TextRun[][]

  try {
    pages = await extractRuns(file)
  } catch {
    return {
      data: [],
      errors: [`Couldn't read "${file.name}" — it may be corrupted or password-protected.`],
    }
  }

  const data: CartItem[] = []
  const errors: string[] = []
  let sawHeader = false

  for (const [pageIndex, runs] of pages.entries()) {
    const lines = groupIntoLines(runs)
    const header = findColumnAnchors(lines)
    if (!header) continue // e.g. a cover page — only pages with the table matter

    sawHeader = true
    const where = pages.length > 1 ? ` (page ${pageIndex + 1})` : ''

    for (const line of lines.slice(header.index + 1)) {
      const joined = line.map((run) => run.text).join(' ')
      const cells = splitByColumns(line, header.anchors)

      if (isNoiseLine(cells, joined)) continue

      const missing = COLUMNS.filter((column) => !cells[column])
      if (missing.length > 0) {
        errors.push(`Skipped "${joined.trim()}"${where} — missing ${missing.join(', ')}.`)
        continue
      }

      const basePrice = parsePrice(cells.price)
      if (basePrice === null) {
        errors.push(`Skipped "${joined.trim()}"${where} — "${cells.price}" isn't a valid price.`)
        continue
      }

      data.push({
        // The PDF format in the brief carries no item ids, so they're assigned
        // in reading order to keep the results table stable and referable.
        itemId: `ITEM-${String(data.length + 1).padStart(2, '0')}`,
        product: cells.product,
        brand: cells.brand,
        platform: cells.platform,
        basePrice,
      })
    }
  }

  if (!sawHeader) {
    return {
      data: [],
      errors: [
        `No item table found in "${file.name}". Expected columns: Product, Brand, Platform, Base Price.`,
      ],
    }
  }

  if (data.length === 0 && errors.length === 0) {
    errors.push(`Found the table in "${file.name}" but no readable item rows.`)
  }

  return { data, errors }
}

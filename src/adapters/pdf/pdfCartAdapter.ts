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
 * Once lines are rebuilt into cells, interpretation is handed to the shared
 * table mapper — so a PDF, a spreadsheet and a Word table all inherit the same
 * column aliases, price handling and per-row error wording.
 */

import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { AdapterResult, CartItem } from '../../engine/types'
import { COLUMNS, HEADER_ALIASES, tableToCart, type Column } from '../table/tableToCart'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

interface TextRun {
  text: string
  x: number
  y: number
}

/** Text runs whose baselines are within this many points count as one line. */
const LINE_TOLERANCE = 3

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

    // Hand the reconstructed cells to the shared mapper as a plain table: a
    // synthetic header row (the anchors already told us the column order) plus
    // one row per line. Interpretation and error wording are then identical
    // across PDF, spreadsheet and Word.
    const table: string[][] = [
      [...COLUMNS],
      ...lines
        .slice(header.index + 1)
        .map((line) => {
          const cells = splitByColumns(line, header.anchors)
          return COLUMNS.map((column) => cells[column])
        }),
    ]

    // Item ids continue across pages rather than restarting at ITEM-01.
    const page = tableToCart(table, { where, startIndex: data.length })
    data.push(...page.data)
    errors.push(...page.errors)
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

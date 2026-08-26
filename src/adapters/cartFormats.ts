/**
 * cartFormats.ts
 *
 * THE CART INPUT REGISTRY — the one place that knows which formats exist.
 *
 * `App.tsx` used to branch on `isPdf ? … : …`, which was fine for two formats
 * and untenable at four. Every format now declares its own extensions and its
 * own loader, so supporting a fifth means adding one entry to this array — no
 * conditional to extend, no component to edit, and nothing in `src/engine/`
 * that even knows this file exists.
 *
 * Only CSV is bundled eagerly. pdf.js, SheetJS and mammoth are each ~1MB, so
 * their adapters are behind dynamic `import()` and a user who only ever uploads
 * a CSV downloads none of the three.
 */

import type { AdapterResult, CartItem } from '../engine/types'
import { parseCartCsv } from './csv/csvCartAdapter'

export interface CartFormat {
  /** Shown in the UI as the source badge, e.g. "via XLSX". */
  id: 'CSV' | 'PDF' | 'XLSX' | 'DOCX'
  /** Lowercase, dot-prefixed. First entry is the canonical one. */
  extensions: string[]
  load: (file: File) => Promise<AdapterResult<CartItem>>
}

export const CART_FORMATS: CartFormat[] = [
  {
    id: 'CSV',
    extensions: ['.csv'],
    load: async (file) => parseCartCsv(await file.text()),
  },
  {
    id: 'PDF',
    extensions: ['.pdf'],
    load: async (file) => (await import('./pdf/pdfCartAdapter')).parseCartPdf(file),
  },
  {
    id: 'XLSX',
    extensions: ['.xlsx'],
    load: async (file) => (await import('./xlsx/xlsxCartAdapter')).parseCartXlsx(file),
  },
  {
    id: 'DOCX',
    extensions: ['.docx'],
    load: async (file) => (await import('./docx/docxCartAdapter')).parseCartDocx(file),
  },
]

/** The format whose extension this file matches, or undefined if none does. */
export function formatFor(file: File): CartFormat | undefined {
  const name = file.name.toLowerCase()
  return CART_FORMATS.find((format) =>
    format.extensions.some((extension) => name.endsWith(extension))
  )
}

/** Every supported extension, for the file input's `accept` attribute. */
export const CART_ACCEPT = CART_FORMATS.flatMap((format) => format.extensions).join(',')

/** Human-readable list for error messages and UI copy — "CSV, PDF, XLSX or DOCX". */
export const CART_FORMAT_NAMES = CART_FORMATS.map((format) => format.id)
  .join(', ')
  .replace(/, ([^,]*)$/, ' or $1')

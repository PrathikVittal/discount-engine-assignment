/**
 * App.tsx — orchestration.
 *
 * This is the ONLY module that knows all the input adapters exist. It hands each
 * one its raw input, keeps the `CartItem[]` / `DiscountRule[]` they return, and
 * passes those to `calculate`. Adding a fourth input mode means adding an adapter
 * and a control here — the engine is untouched.
 *
 * Results are derived from state rather than stored, so every change to the cart
 * or the rules re-runs the engine automatically and stale output is impossible.
 */

import { useMemo, useState } from 'react'
import { CART_ACCEPT, CART_FORMAT_NAMES, formatFor, type CartFormat } from './adapters/cartFormats'
import { parseRulesCsv } from './adapters/csv/csvRulesAdapter'
import DataTable, { type Column } from './components/DataTable'
import FileDropzone from './components/FileDropzone'
import MessageBanner from './components/MessageBanner'
import ResultsPanel from './components/ResultsPanel'
import RuleComposer from './components/RuleComposer'
import { calculate } from './engine/discountEngine'
import type { CartItem, DiscountRule } from './engine/types'

const rupees = (amount: number) => `Rs.${amount.toLocaleString('en-IN')}`

/** Where a loaded set of data came from — shown so re-runs are traceable. */
/** Where the loaded data came from — a cart format id, or 'Text' for a rule typed by hand. */
type Source = { label: string; via: CartFormat['id'] | 'Text' } | null

const RULE_COLUMNS: Column<DiscountRule>[] = [
  { key: 'ruleId', label: 'Rule' },
  { key: 'scope', label: 'Scope', render: (r) => capitalise(r.scope) },
  { key: 'appliesTo', label: 'Applies To', render: (r) => r.appliesTo ?? 'Entire cart' },
  {
    key: 'value',
    label: 'Discount',
    render: (r) => (r.type === 'percentage' ? `${r.value}% off` : `${rupees(r.value)} off`),
  },
  {
    key: 'minCartValue',
    label: 'Condition',
    render: (r) => {
      if (r.minCartValue !== undefined) return `Cart ≥ ${rupees(r.minCartValue)}`
      // An unconditional cart rule applies to every cart — say so, rather than
      // showing a dash that reads like "no data".
      if (r.scope === 'cart') return 'Always'
      return <span className="no-offer">—</span>
    },
  },
  {
    key: 'stackable',
    label: 'Stackable',
    render: (r) =>
      r.stackable ? <span className="tag tag-stack">Stacks</span> : <span className="no-offer">No</span>,
  },
]

const CART_COLUMNS: Column<CartItem>[] = [
  { key: 'itemId', label: 'Item' },
  { key: 'product', label: 'Product' },
  { key: 'brand', label: 'Brand' },
  { key: 'platform', label: 'Platform' },
  { key: 'basePrice', label: 'Base Price', align: 'right', render: (r) => rupees(r.basePrice) },
]

export default function App() {
  const [rules, setRules] = useState<DiscountRule[]>([])
  const [ruleErrors, setRuleErrors] = useState<string[]>([])
  const [ruleSource, setRuleSource] = useState<Source>(null)

  const [cart, setCart] = useState<CartItem[]>([])
  const [cartErrors, setCartErrors] = useState<string[]>([])
  const [cartSource, setCartSource] = useState<Source>(null)
  const [cartBusy, setCartBusy] = useState(false)

  const [hasRun, setHasRun] = useState(false)

  // The single call into the engine. Re-runs whenever cart or rules change.
  const result = useMemo(() => calculate(cart, rules), [cart, rules])

  // ── Adapter handlers: raw input → normalised data → state ──

  async function handleRulesFile(file: File) {
    const { data, errors } = parseRulesCsv(await file.text())

    // Same guard as the cart: a file that yields no usable rules must not wipe
    // the rules already loaded. Silently emptying them would drop every discount
    // and make the cart total jump to full price with no obvious cause.
    if (data.length === 0) {
      setRuleErrors([
        `No usable rules found in "${file.name}" — keeping the ${rules.length} rule${
          rules.length === 1 ? '' : 's'
        } already loaded.`,
        ...errors,
      ])
      return
    }

    setRules(data)
    setRuleErrors(errors)
    setRuleSource({ label: file.name, via: 'CSV' })
  }

  async function handleCartFile(file: File) {
    // The only place the input format matters — look up an adapter, then forget
    // it. Every format returns the same { data, errors }, so nothing below here
    // (and nothing in the engine) knows which one ran.
    const format = formatFor(file)
    if (!format) {
      setCartErrors([`"${file.name}" isn't a supported cart file. Use ${CART_FORMAT_NAMES}.`])
      return
    }

    setCartBusy(true)
    try {
      const { data, errors } = await format.load(file)

      setCartErrors(errors)
      // Only replace the cart if something parsed; a failed upload shouldn't
      // silently empty a cart the user already had.
      if (data.length > 0) {
        setCart(data)
        setCartSource({ label: file.name, via: format.id })
      }
    } finally {
      setCartBusy(false)
    }
  }

  function handleAddRule(rule: DiscountRule) {
    setRules((current) => [...current, rule])
    setRuleSource((current) => current ?? { label: 'Added by hand', via: 'Text' })
  }

  const nextRuleId = `RULE-${String(rules.length + 1).padStart(2, '0')}`
  const canRun = rules.length > 0 && cart.length > 0

  return (
    <>
      <header className="header">
        <div className="logo">
          O<span>pp</span>tra
        </div>
        <div className="header-sub">Discount Engine</div>
      </header>

      <main className="main">
        <div className="grid-2">
          {/* ── Rules input ── */}
          <section className="card">
            <h2 className="card-title">Discount Rules</h2>
            <FileDropzone
              label="rules.csv"
              description="Upload your discount rules"
              accept=".csv"
              onFile={handleRulesFile}
              loadedName={ruleSource?.via === 'CSV' ? ruleSource.label : undefined}
            />
            <MessageBanner messages={ruleErrors} tone="warn" />
            {rules.length > 0 && (
              <div className="data-preview">
                <div className="hint data-count">
                  {rules.length} active rule{rules.length > 1 ? 's' : ''}
                </div>
                <DataTable columns={RULE_COLUMNS} rows={rules} />
              </div>
            )}
          </section>

          {/* ── Cart input ── */}
          <section className="card">
            <h2 className="card-title">Cart Items</h2>
            <FileDropzone
              label="cart.csv, .pdf, .xlsx or .docx"
              description={`Upload a cart — ${CART_FORMAT_NAMES}`}
              accept={CART_ACCEPT}
              onFile={handleCartFile}
              loadedName={cartSource?.label}
              busy={cartBusy}
            />
            <MessageBanner messages={cartErrors} tone="warn" />
            {cart.length > 0 && (
              <div className="data-preview">
                <div className="hint data-count">
                  {cart.length} item{cart.length > 1 ? 's' : ''}
                  {cartSource && <span className="tag tag-source source-tag">via {cartSource.via}</span>}
                </div>
                <DataTable columns={CART_COLUMNS} rows={cart} />
              </div>
            )}
          </section>
        </div>

        {/* ── Natural-language rule input (Task 2) ── */}
        <section className="card">
          <h2 className="card-title">Add a Rule in Plain English</h2>
          <RuleComposer nextRuleId={nextRuleId} onAddRule={handleAddRule} />
        </section>

        {!hasRun && (
          <div style={{ textAlign: 'center', marginBottom: '1.2rem' }}>
            <button className="btn" onClick={() => setHasRun(true)} disabled={!canRun}>
              Calculate Discounts
            </button>
            {!canRun && <div className="hint">Load rules and a cart to calculate</div>}
          </div>
        )}

        {hasRun && canRun && <ResultsPanel result={result} />}

        {hasRun && !canRun && (
          <MessageBanner
            tone="warn"
            title="Nothing to calculate"
            messages={['Load both a rules file and a cart to see results.']}
          />
        )}
      </main>
    </>
  )
}

function capitalise(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

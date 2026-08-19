/**
 * ResultsPanel.tsx — the checkout view.
 *
 * Reads a CartCalculationResult and renders it. It performs no arithmetic of its
 * own: every figure here, including the cart offer, comes from the engine, so
 * what the customer sees cannot drift from what was calculated.
 */

import type { CartCalculationResult, ItemDiscountResult } from '../engine/types'
import DataTable, { type Column } from './DataTable'

const rupees = (amount: number) => `Rs.${amount.toLocaleString('en-IN')}`

const COLUMNS: Column<ItemDiscountResult>[] = [
  { key: 'itemId', label: 'Item' },
  { key: 'product', label: 'Product' },
  {
    key: 'basePrice',
    label: 'Base Price',
    align: 'right',
    render: (row) => rupees(row.basePrice),
  },
  {
    key: 'finalPrice',
    label: 'Final Price',
    align: 'right',
    render: (row) => <span className="price-final">{rupees(row.finalPrice)}</span>,
  },
  {
    key: 'totalDiscount',
    label: 'You Save',
    align: 'right',
    render: (row) =>
      row.totalDiscount > 0 ? (
        <span className="saving">{rupees(row.totalDiscount)}</span>
      ) : (
        <span className="no-offer">—</span>
      ),
  },
  {
    key: 'reasoning',
    label: 'Offer Applied',
    render: (row) =>
      row.appliedRules.length === 0 ? (
        <span className="no-offer">{row.reasoning}</span>
      ) : (
        <span>
          {row.reasoning}{' '}
          <span className="hint" style={{ marginTop: 0 }}>({row.appliedRules.join(' + ')})</span>
        </span>
      ),
  },
]

export default function ResultsPanel({ result }: { result: CartCalculationResult }) {
  const { cartOffer } = result

  return (
    <div className="card">
      <h2 className="card-title">Cart Summary</h2>

      <DataTable columns={COLUMNS} rows={result.items} />

      <div className="totals">
        <div className="total-line">
          <span className="label">Cart total before offer</span>
          <span className="value">{rupees(result.subtotal)}</span>
        </div>

        {/* Each cart offer is its own line — never folded into an item price.
            A stackable cart rule appears as an additional line beneath the
            winning non-stackable one. */}
        {cartOffer.lines.map((line) => (
          <div key={line.ruleId} className="total-line cart-offer">
            <span className="label">
              {line.reasoning}
              <span className="hint" style={{ marginTop: 0 }}>
                {' '}({line.ruleId}{line.stackable ? ', stacked' : ''})
              </span>
            </span>
            <span className="value">−{rupees(line.amountSaved)}</span>
          </div>
        ))}

        <div className="total-line grand">
          <span className="label">Final cart total</span>
          <span className="value">{rupees(result.finalTotal)}</span>
        </div>

        {result.totalSaved > 0 && (
          <div className="total-line">
            <span className="label">Total saved</span>
            <span className="value saving">{rupees(result.totalSaved)}</span>
          </div>
        )}
      </div>

      {/* Tells a customer sitting just under the threshold how close they are,
          rather than showing them nothing at all. Shown even when another cart
          offer already applied — there may still be a bigger one within reach. */}
      {cartOffer.nearMiss && (
        <div className="banner info" style={{ marginTop: '0.9rem' }}>
          Add {rupees(cartOffer.nearMiss.shortfall)} more to unlock the{' '}
          {rupees(cartOffer.nearMiss.minCartValue)} cart offer ({cartOffer.nearMiss.ruleId}).
        </div>
      )}
    </div>
  )
}

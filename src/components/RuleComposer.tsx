/**
 * RuleComposer.tsx — Task 2's UI: plain English in, a confirmable rule out.
 *
 * Three states, and only one of them can add a rule:
 *   idle          → text box
 *   unresolvable  → the reason, shown as guidance, nothing added
 *   parsed        → every field laid out for review; Add or Discard
 *
 * Nothing reaches the cart without an explicit click on "Add rule & re-run".
 */

import { useState } from 'react'
import { parseRuleFromText, type RuleParseOutcome } from '../adapters/llm/llmRuleAdapter'
import type { DiscountRule } from '../engine/types'
import MessageBanner from './MessageBanner'

const EXAMPLES = [
  '20% off for Natura Casa brand, stackable with other offers',
  'Rs.100 flat discount on all Flipkart items',
  '10% off if cart value is more than Rs.5,000',
  'Additional 10% off the whole cart after all discounts',
  'Give a discount for big orders',
]

interface Props {
  /** Id the next rule will take, shown up front so the confirmation is complete. */
  nextRuleId: string
  onAddRule: (rule: DiscountRule) => void
}

export default function RuleComposer({ nextRuleId, onAddRule }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<RuleParseOutcome | null>(null)

  async function handleParse() {
    if (!text.trim() || busy) return
    setBusy(true)
    setOutcome(null)
    try {
      setOutcome(await parseRuleFromText(text, nextRuleId))
    } finally {
      setBusy(false)
    }
  }

  function handleConfirm() {
    if (outcome?.status !== 'parsed') return
    onAddRule(outcome.rule)
    setOutcome(null)
    setText('')
  }

  const parsed = outcome?.status === 'parsed' ? outcome : null

  return (
    <div>
      <div className="rule-input">
        <textarea
          value={text}
          placeholder='Describe an offer, e.g. "15% off everything on Flipkart"'
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            // Enter submits; Shift+Enter for a newline.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void handleParse()
            }
          }}
          rows={2}
        />
        <button className="btn" onClick={handleParse} disabled={busy || !text.trim()}>
          {busy && <span className="spinner" />}
          {busy ? 'Reading' : 'Parse rule'}
        </button>
      </div>

      <div className="examples">
        <span className="hint examples-label">Try:</span>
        {EXAMPLES.map((example) => (
          <button
            key={example}
            type="button"
            className="example-chip"
            onClick={() => {
              setText(example)
              setOutcome(null)
            }}
          >
            {example}
          </button>
        ))}
      </div>

      {outcome?.status === 'unresolvable' && (
        <MessageBanner
          tone="warn"
          title="Couldn't turn that into a rule"
          messages={[outcome.reason]}
        />
      )}

      {parsed && (
        <div className="confirm-card">
          <div className="confirm-title">Confirm this rule before it's applied</div>

          <div className="confirm-fields">
            <Field label="Rule ID" value={parsed.rule.ruleId} />
            <Field label="Scope" value={capitalise(parsed.rule.scope)} />
            {parsed.rule.scope !== 'cart' && (
              <Field label="Applies to" value={parsed.rule.appliesTo ?? '—'} />
            )}
            <Field label="Type" value={capitalise(parsed.rule.type)} />
            <Field
              label="Value"
              value={
                parsed.rule.type === 'percentage'
                  ? `${parsed.rule.value}% off`
                  : `Rs.${parsed.rule.value.toLocaleString('en-IN')} off`
              }
            />
            {parsed.rule.scope === 'cart' && (
              <Field
                label="Min cart value"
                value={
                  parsed.rule.minCartValue !== undefined
                    ? `Rs.${parsed.rule.minCartValue.toLocaleString('en-IN')}`
                    : 'None — applies to every cart'
                }
              />
            )}
            <Field label="Stackable" value={parsed.rule.stackable ? 'Yes' : 'No'} />
            {parsed.rule.scope === 'cart' && parsed.rule.stackable && (
              <Field label="Applied" value="Last — after other discounts" />
            )}
          </div>

          <div className="btn-row">
            <button className="btn" onClick={handleConfirm}>
              Add rule &amp; re-run
            </button>
            <button className="btn btn-secondary" onClick={() => setOutcome(null)}>
              Discard
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="confirm-field">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  )
}

function capitalise(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

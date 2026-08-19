/**
 * parse-rule.ts — POST /api/parse-rule
 *
 * The only server-side piece of this app. It exists purely so the OpenAI API
 * key stays out of the browser bundle; it holds no state and no discount logic.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { ModelBusyError, NotConfiguredError, parseRuleFromText } from './_parseRule.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ ok: false, reason: 'Use POST.' })
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body
    const result = await parseRuleFromText(body?.text)
    // A rule we could not resolve is a valid outcome, not an HTTP failure —
    // the UI renders `reason` as guidance either way.
    return res.status(200).json(result)
  } catch (error) {
    if (error instanceof NotConfiguredError) {
      return res.status(503).json({ ok: false, reason: error.message })
    }
    if (error instanceof ModelBusyError) {
      return res.status(503).json({ ok: false, reason: error.userMessage })
    }
    console.error('[parse-rule]', error)
    return res.status(502).json({
      ok: false,
      reason: 'The rule parser is unavailable right now. Please try again.',
    })
  }
}

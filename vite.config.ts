import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * In production the `/api/parse-rule` endpoint is a Vercel serverless function.
 * Vite's dev server doesn't know about `api/`, so this plugin mounts the *same*
 * parsing module at the same path locally — `npm run dev` then behaves like the
 * deployed app, and there is only one implementation to keep correct.
 */
function devApiPlugin(): Plugin {
  return {
    name: 'discount-engine-dev-api',
    configureServer(server) {
      server.middlewares.use('/api/parse-rule', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Content-Type', 'application/json')
          return res.end(JSON.stringify({ ok: false, reason: 'Use POST.' }))
        }

        const send = (status: number, payload: unknown) => {
          res.statusCode = status
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify(payload))
        }

        try {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(chunk as Buffer)
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')

          // Loaded through Vite so the TypeScript source is used directly.
          const mod = await server.ssrLoadModule('/api/_parseRule.ts')
          send(200, await mod.parseRuleFromText(body.text))
        } catch (error) {
          const name = error instanceof Error ? error.constructor.name : ''
          if (name === 'NotConfiguredError') {
            return send(503, { ok: false, reason: (error as Error).message })
          }
          if (name === 'ModelBusyError') {
            return send(503, {
              ok: false,
              reason: (error as { userMessage?: string }).userMessage,
            })
          }

          server.config.logger.error(`[parse-rule] ${String(error)}`)
          send(502, {
            ok: false,
            reason: 'The rule parser is unavailable right now. Please try again.',
          })
        }
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  // Make OPENAI_API_KEY from .env available to the dev middleware (server-side
  // only — Vite never exposes an unprefixed variable to the client bundle).
  const env = loadEnv(mode, process.cwd(), '')
  if (env.OPENAI_API_KEY) process.env.OPENAI_API_KEY = env.OPENAI_API_KEY
  if (env.OPENAI_MODEL) process.env.OPENAI_MODEL = env.OPENAI_MODEL

  return { plugins: [react(), devApiPlugin()] }
})

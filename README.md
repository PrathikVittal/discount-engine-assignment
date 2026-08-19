# Opptra Discount Engine

A customer-facing cart pricing engine. Brands and platforms run competing discounts; for each item the engine applies the rule giving the **largest rupee saving**, stacks any stackable rule on top, then applies cart-wide offers as a separate line — and explains every price in plain language.

**Live demo:** https://discount-engine-assignment-dte7.vercel.app/

## Run locally

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173, upload `sample-data/rules.csv` and `sample-data/cart.csv`, then click **Calculate Discounts**.

> For the natural-language rule input (Task 2), copy `.env.example` to `.env` and add an `OPENAI_API_KEY` (platform.openai.com/api-keys). Everything else — CSV, PDF, the engine itself — runs without a key.
>
> If you hit a rate limit, the app says so explicitly and tells you how long to wait rather than failing silently.

Other commands: `npm test` (50 engine + adapter tests), `npm run typecheck`, `npm run build`.

A second, larger dataset is included — `sample-data/rules1.csv` (15 rules) with `sample-data/sample-cart-30.pdf` (30 items). It exercises combinations the six-item sample can't: two competing platform rules on one item, two stackable rules on one item, and two cart rules qualifying simultaneously.

## Architecture: one engine, three interchangeable adapters

The design constraint driving everything: **you can add a fourth input mode without touching the discount calculator.**

```
  CSV adapter  ─┐
  PDF adapter  ─┼──►  CartItem[] + DiscountRule[]  ──►  calculate()  ──►  results  ──►  UI
  LLM adapter  ─┘         (the only contract)          (pure function)
```

- `src/engine/` is a **pure function**: `calculate(cart, rules)`. No I/O, no React, no knowledge of where its inputs came from. Same inputs always produce the same output.
- `src/adapters/` holds three independent input paths. Each one's only job is to produce `CartItem[]` or `DiscountRule[]`, and each returns the same `{ data, errors }` shape so a malformed row is reported and skipped rather than fatal.
- `src/App.tsx` is the only module that knows all three adapters exist.

Adding, say, a barcode scanner means writing one adapter file and one UI control. The engine and its tests stay untouched.

```
src/
  engine/
    types.ts              the adapter ⇄ engine contract
    discountEngine.ts     calculate() — pure, the whole of the pricing logic
    ruleSchema.ts         Zod schema shared by the browser and the server
    discountEngine.test.ts
  adapters/
    csv/                  rules.csv + cart.csv
    llm/                  plain English → DiscountRule (calls /api/parse-rule)
    pdf/                  cart PDF → CartItem[] (pdf.js, client-side, lazy-loaded)
    adapters.test.ts
  components/             presentational only
  App.tsx                 orchestration
api/
  parse-rule.ts           serverless fn — the only place the API key lives
sample-data/              sample CSVs + generated cart PDFs
ARCHITECTURE.md           design rationale and the full tradeoff table
```

## Discount logic

1. Collect the rules matching an item; split non-stackable from stackable.
2. Among non-stackable matches, apply the one with the **largest rupee saving**. Scope is irrelevant — a brand rule and a platform rule compete purely on amount.
3. Apply stackable rules on top of that result. With no non-stackable winner, a stackable rule applies to the base price alone.
4. No matches → base price + "No offers available".
5. Cart rules run **last**, against the sum of final item prices, as separate lines — never folded into an item. They obey the same max-then-stack logic as item rules: a stackable cart rule applies on top of the winning non-stackable one.

## Verified against the brief

`npm test` asserts these exact figures:

| Item | Base | Rule(s) applied | Final |
|------|------|-----------------|-------|
| ITEM-01 | Rs.1,299 | RULE-01 wins (Rs.195 saving beats Rs.150) | **Rs.1,104** |
| ITEM-02 | Rs.849 | RULE-02 (−Rs.150) + RULE-03 stacked (−10%) | **Rs.629** |
| ITEM-03 | Rs.599 | RULE-01 (15% off) | **Rs.509** |
| ITEM-04 | Rs.2,499 | No rules match | **Rs.2,499** |
| ITEM-05 | Rs.449 | RULE-01 (15% off) | **Rs.382** |
| ITEM-06 | Rs.899 | RULE-03 (10% off, stackable) | **Rs.809** |
| | | Cart total before offer | Rs.5,932 |
| | | RULE-04 — 10% off cart ≥ Rs.4,000 | −Rs.593 |
| | | **Final cart total** | **Rs.5,339** |

## The three input modes

**CSV** — `rules.csv` (`rule_id, scope, applies_to, type, value, stackable, min_cart_value`) and `cart.csv` (`item_id, product, brand, platform, base_price`). `scope` is `brand`, `platform`, or `cart`; cart rules leave `applies_to` blank, and `min_cart_value` is optional (blank = applies to every cart).

**Natural language** — describe an offer in plain English; an LLM parses it into a `DiscountRule`, which is validated, shown for confirmation, and only applied when you accept it. Ambiguous input ("give a discount for big orders") comes back as unresolvable with a note on what's missing.

**PDF** — upload a cart PDF with a `Product / Brand / Platform / Base Price` table. It replaces the cart and the engine re-runs immediately. Try `sample-data/sample-cart.pdf`, and `sample-cart-malformed.pdf` to see damaged rows reported individually while the good rows still load.

## Decisions worth flagging

Full reasoning for each is in [ARCHITECTURE.md](ARCHITECTURE.md) — including [§9, where I'd push back on the brief](ARCHITECTURE.md#9-where-id-push-back-on-the-brief) (the PDF format assumption, the read-only confirmation card, dead-ending an ambiguous parse, and "a backend is optional"). The short version:

- **Rounding — to the nearest rupee after every discount step.** The brief mixes Rs.194.85 with a Rs.1,104 result. Rounding once at the end doesn't reproduce the brief's own figures for ITEM-02 or the cart total; rounding per step reproduces all of them.
- **A serverless function for the LLM call, not a browser fetch.** This is the one deliberate departure from "no backend needed". A Vite app ships its whole bundle to the client, so an API key embedded there is readable from the network tab. `api/parse-rule.ts` keeps it server-side; the same module is mounted in the Vite dev server so `npm run dev` behaves identically to production.
- **The parsed rule is validated twice** — once on the server before responding, once in the browser before the confirmation card renders. The UI never shows a rule as confirmable on the endpoint's word alone. This layer is load-bearing: "150% off everything on Noon" is rejected by the schema, not by the model.
- **Three distinguishable LLM failure modes** — not configured, temporarily busy (retried with backoff), and genuinely unresolvable input. A capacity blip shouldn't read as "your sentence was bad".
- **A malformed PDF or CSV row is skipped and named, not fatal.** One damaged line shouldn't cost a customer their whole cart. A failed upload also leaves the previous cart intact rather than silently emptying it.
- **The cart threshold is inclusive (`>=`)** per "meets or exceeds". Below it, the offer row is absent entirely rather than shown as Rs.0 — and the customer is told how much more unlocks it.
- **A cart rule's threshold is optional.** "20% off the whole cart" is a valid unconditional offer; what stays unresolvable is an *implied but unstated* threshold ("15% off big orders"), which gets an error offering both fixes. Unconditional rules display as "Always" so a blank `min_cart_value` is never silently permissive.
- **Results are derived, not stored.** They recompute from `(cart, rules)`, so adding a rule or replacing the cart re-runs the engine automatically and stale output is structurally impossible.

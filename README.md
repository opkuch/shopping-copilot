# Bazak shopping copilot

A local chat that helps you find products in the DummyJSON catalog. You describe what you want; the server works out the intent, queries the catalog, and answers with a short sentence and product cards inside the chat. Conversations are saved on the server, survive a refresh, and can be listed and continued.

## Setup and run

Requirements: Node 24 or newer (`.nvmrc` pins 24; the server checks at startup).

```bash
cp server/.env.example server/.env    # then set OPENAI_API_KEY in server/.env
npm run setup                         # installs server and web, builds the web app
npm start                             # http://127.0.0.1:3000
```

One process serves the API (`/api/*`) and the built web app, on `127.0.0.1` only.

```bash
npm test                                      # server (node:test) + web (Vitest), offline, no API key
npm run typecheck
npx --prefix web playwright install chromium  # once
npm run e2e                                   # browser tests on the real server with scripted models
npm --prefix server run eval:product          # opt-in, paid: end-to-end eval with live models
npm --prefix server run eval:sim              # opt-in, paid: simulated shoppers, pipeline vs. baseline
```

## Architecture and framework choice

```
browser (React SPA) ──JSON──▶ Fastify (/api) ──▶ one turn
   cards, chips,               idempotent POST     ├─ router     Decisions API: what to do with the screen
   polls progress              per message id      ├─ extractor  structured output: what products are wanted
                                                   ├─ retrieval  DummyJSON (cached) + code filters
                              SQLite ◀─────────────┴─ reply      model writes from decided facts; template fallback
```

**Built from scratch in TypeScript.** Runtime dependencies: `fastify`, `openai`, `zod` on the server; `react`, `react-dom` and a self-hosted font in the browser.

The turn is **not an agent with tools**. Two model calls with fixed jobs run in parallel, then plain code picks the endpoint, applies price, stock and gender filters, and caps the cards. Every branch is a line a test can point at, and every turn writes a trace (`GET /api/messages/:id/trace`).

Alternatives I rejected:

- **A tool-calling agent loop.** DummyJSON can't combine category, keyword and price in one request, so a model choosing parameters would invent ones the API doesn't have, and no test could point at the line that made the choice.
- **Vercel AI SDK.** Its main path is a streamed message protocol (`streamText`, `useChat`). I don't stream (below), so I'd keep its state shape and still write my own retry, conflict and resend handling.
- **LangChain / LangGraph.** My branches (router failed, one of two groups unavailable, resend of the same message) are plain functions a test calls directly. A graph adds a large dependency to wrap one call, and its checkpointer would duplicate the SQLite transcript.
- **assistant-ui / CopilotKit.** Chat shells built around a streaming thread runtime; I'd write an adapter to my idempotency rules and still hand-write every product widget.

**No streaming.** A turn's latency is the router, extraction and the catalog fetch, before any reply token exists. Instead the client polls progress and shows the real stage ("Understanding your request… → Searching the catalog…"). Cards are published as soon as retrieval is done; the model's sentence replaces a template sentence about a second later, in the same element, so the cards stay put and only the sentence and the chips change.

**The simplest alternative, measured.** The simulated-shopper eval also runs a baseline: one model call per turn with the whole 194-product catalog in the prompt. Before this round of fixes the baseline won: 98% task success against the pipeline's 93%, at 2.7 s per turn against 4.5 s. Most of the pipeline's failed conversations were a shopper asking about a product ("is it good for workouts?") and getting the same canned description twice. With that fixed, the pipeline reaches 96% (one run per goal, 4.3 s). I keep the pipeline because the assignment is about retrieving from the API, the baseline only works while the catalog fits in a prompt, and in the pipeline every product, price and count shown comes from code, not from the model.

## Retrieval strategy

**Two model calls, different jobs** (`gpt-6-luna`, the only allowed model):

- The **router** (Decisions API) answers closed questions about the turn: new search, refine, ask about a shown card, show more, reject what's shown, or chat; catalog, service, or off topic; which shown card or group. The card choices are built per turn from what is on screen, so it can't pick a card that doesn't exist.
- The **extractor** (structured output) returns up to two intents: category (one of 24 slugs), a head noun, attribute words, price bounds, currency, sort, stock, relative price ("cheaper"), gift, and an occasion or place.

Why two calls: the router answers in about 0.3 s, extraction in about 2.7 s. 29% of turns (chat, service, "tell me about it", show more) don't need extraction and finish without waiting for it. I don't use the router's confidence: in the evals, 70% of its wrong answers came with 0.95 or more. Where the router was measured to misread a phrasing, a small rule in `pipeline/decide.ts` overrides it, and each rule is a row in `test/decide.test.ts`.

**Endpoints**, chosen by code:

| Query | Request | Then, in code |
| --- | --- | --- |
| A category is known | `GET /products/category/{slug}?limit=0` | match words, filter price/stock/gender, sort, cap at 4 |
| Anything else | `GET /products?limit=0` (cached, 194 products) | the same matching over the whole catalog |
| A shown product ("tell me about it", a click on a card) | `GET /products/{id}` | brand, warranty, shipping, returns, reviews |

List requests use `select=` for the card fields. No endpoint filters by price, stock or brand, category and search can't be combined, and `sortBy` sorts a page before any filter could run, so code fetches the candidates and filters and sorts itself. I don't use `/products/search`: it matches `q` as one substring (`q=red lipstick` finds 1, `q=lipstick red` finds 0), so it can't find Juice for "drink". The list call is cached for 5 minutes and served stale if DummyJSON is down.

**What a word matches.** The product type (noun) matches a title, a tag, a category, or a reviewed keyword. Keywords come from one offline model pass (`npm run enrich:catalog`, committed as `src/catalog/enrichment.json`) that lists words shoppers use that the catalog doesn't: earbud for AirPods, drink for Juice, running shoe for the sneakers. I review them like code; the first pass gave a cup "hot drink", which would show a cup for "something to drink". Whole words only: "ring" never matches "spring".

**When nothing matches exactly**, constraints are dropped in order, and the reply says what was dropped: a full product name → the noun outside a guessed category → the noun with the most attribute words kept → the brand without the noun → the noun alone → other products in a category the user named → an honest miss. Price, stock, gender and a stated category are never relaxed. A product type the catalog lacks (a fridge, a kettle) is a miss, never the nearest appliance.

**Order.** With no order asked for: products matching more of the user's words first, then the best rated. "Cheap", "best rated", a budget or "the most expensive" always win.

**Ambiguous requests ("something cheap and cool").** The extractor reports only what was said; code decides from reviewed tables in `pipeline/purpose.ts`:

- Nothing to go on ("surprise me", "something cheap and cool"): a spread across shop-window categories (beauty, fragrances, sunglasses, home, sports, gadgets, jewellery), one per category, rated 4★ or more, with chips to narrow it. "Cool" is not a keyword; "cheap" with no number is a sort.
- A gift without a budget: one question, with tappable chips for budget and recipient, asked at most once. Whatever the answer gives ("for her"), the next reply shows gift ideas with what is known and offers the budget as chips. With a budget: gift ideas for that recipient, leading with products that use the budget.
- An occasion ("for a friend's wedding", Valentine's Day) is a gift. A place with no product ("something for the beach"): one question, what kind of product, never a guessed set.

**Off-catalog ("a flight to Tokyo").** The router marks it a service: no catalog call, a reply that says I can't book trips or check orders, and example searches as chips. "Headphones and a flight to Tokyo" searches the headphones and adds that travel can't be booked; "headphones for my flight" just searches.

**Multi-intent ("a laptop and a perfume under 50").** Up to two intents, fetched in parallel, each its own labelled group. A constraint belongs to the product it's written next to, so the $50 applies to the perfume only. The extractor is told so, and when it still copies one bound onto both products, code moves it to the product named just before the number (`scopePrices` in `pipeline/merge.ts`), unless the message says "both", "each" or puts the bound before the list. A third intent is dropped and the reply says so. One group can fail to load while the other shows cards. "Make it cheaper" with two groups on screen asks which one.

**Following up.** "Show more", "something cheaper" (never a search that quietly drops "white"), "tell me about the second one" or a click on a card, "and for a woman?". Cards of the current search are numbered so "the second one" is visible. A short conversation memory keeps the purpose ("a gift for her") and rejected kinds ("not earrings").

**Changing your mind.** A follow-up is merged into the search on screen by three rules, not by a case per phrasing:

- *A message replaces what it says and keeps the rest.* Price is one constraint: "more expensive" after "a gift under $200" is above the cards shown with no cap, and "over $500" replaces "under $200" rather than making an impossible range. A message that says nothing about price ("not jewelry") keeps the budget.
- *Derived state is rebuilt from its inputs.* A gift's categories come from whom it is for, so "actually it's for my mom" after "for my dad" gets her gift set.
- *Context the user didn't restate never empties a result.* After "a gift for my dad", "a dress for myself" drops the inherited "for men" rather than reporting that there are no dresses. What the user says in the message stays a hard constraint.

**Hebrew.** Shoppers in Israel write Hebrew and think in shekels, so a Hebrew message gets a Hebrew reply and a right-to-left interface, and "עד 1000 שקל" is converted at a fixed ₪3.7 per dollar (stated in the reply, so the same message always searches the same way).

## Conversation and state

**Persistence is on the server, in SQLite** (`server/data/conversations.sqlite`, `node:sqlite`, WAL). The browser keeps only the open conversation's id in the URL (`/c/{id}`); a refresh reloads it from the API. I rejected browser storage (clearing site data would delete chats, and the working search would be client-editable), a JSON file (a crash mid-write can tear the whole history), and Postgres (infrastructure for one local file).

A send stays correct:

- Each message carries a client-generated id. A retry resends the same body; the server returns the stored reply, joins the run in flight, or runs it again. No duplicates, no double model calls.
- Each conversation has a revision. Two tabs sending from the same state: one wins, the other gets `409` with the current transcript and its text back in the input.
- Refresh mid-turn: the server finishes and stores the reply; the reloaded page rejoins the run or offers Retry.

**Storage full:** saving the user message fails in a transaction, nothing is stored, and the user keeps their text. If the reply can't be saved, Retry runs the turn again.
**Corrupted:** at startup `PRAGMA quick_check` runs; a broken file is moved aside, a fresh one opened, and the sidebar says earlier history was set aside. A single unreadable message shows "Couldn't load these results" and the rest of the chat opens.
**User clears browser storage mid-conversation:** nothing is lost; the server is the source of truth.

## Evaluation

1. **Server tests** (312, offline): real retrieval over a recorded copy of the catalog with scripted model answers. They lock the assignment probes, the fallback steps, gifts, follow-ups, price scoping, idempotent resends, the two-tab race, timeouts and corrupt-database recovery.
2. **Web tests** (97, Vitest): every response code, the state reducer, every card, group, chip and error state.
3. **Browser tests** (12, Playwright) on the real server with scripted models, including reload mid-turn, the drawer on a phone, and axe accessibility checks in English and Hebrew.
4. **Product eval** (`eval:product`): what the shopper gets, end to end with live models: the right action, relevant cards (precision/recall against labels), forbidden cards, invented prices or titles, and a judge's grade. 127 development cases, plus a 20-case holdout written separately and never tuned on.
5. **Simulated shoppers** (`eval:sim`, 26 goals): a model shopper with a hidden goal talks to the copilot until it finds the product or gives up, against the pipeline and the one-call baseline.

Latest runs (one pass each, `gpt-6-luna`, prompts router.v6 and prose.v8; development with extract.v11, holdout with extract.v10). They predate the scope cut that removed side-by-side comparison, prices measured from a named product, and place themes, together with the eval cases for them:

| Measure | Development (129 cases) | Holdout (20 cases) |
| --- | ---: | ---: |
| Turns fully right | 90% | 90% |
| Card precision / recall | 0.95 / 0.93 | 1.00 / 0.96 |
| Right action | 95% | 90% |
| Forbidden cards / invented prices or titles | 3 / 0 | 0 / 0 |
| Judge (1–5) | 4.34 | 4.30 |
| Time to cards / full reply, p50 | 2.6 s / 4.7 s | 2.5 s / 4.4 s |

Simulated shoppers: 96% of goals reached (pipeline), 98% for the one-call baseline. The remaining misses are the router reading a request as a different act ("tell me about the ring" as a new search), the extractor scoping a price to the wrong products of a two-product request ("an iPhone and earphones under $200" put the cap on the earphones only, with three iPhones over $200 shown), and latency above my 4 s target.

**Regressions this catches:** a price bound on the wrong group, a lost transcript on refresh, a duplicate message on retry, an ignored conflict, a broken card state, a reply that invents a price, a fallback that drops the product type.
**What slips through:** phrasings outside my test sets (the holdout is the estimate), whether results feel "cool", DummyJSON changing, visual layout (assertions are on text and roles), browsers other than Chromium.

## What I tried and abandoned

- **Embeddings for matching words to products.** Only `gpt-6-luna` is allowed, so I replaced them with one offline pass that writes shopper keywords per product (`enrichment.json`), reviewed like code.
- **DummyJSON's `/products/search`.** It matches `q` as one substring, so word order and synonyms break it. Code matches whole words over the cached catalog instead.
- **Templates for every reply.** They read like a search report. The model now writes the sentence from facts code already decided, every dollar amount it writes is checked against those facts, and the template is the fallback. Grading showed it also had to stop describing the search ("I removed the word 'wireless'") and talk about products.
- **The extractor deciding that the shopper rejected what's shown** (an `exclude` field). That made two models decide the turn's kind, reconciled in code. Rejecting is now one router act; the extractor only describes products.
- **Trusting the router's confidence.** 70% of its wrong answers came with 0.95 or more, so measured misreadings are fixed by small rules in `decide.ts` instead.
- **Price scoping by prompt alone.** The extractor was told a bound belongs to the product next to it and still copied it onto both. Code now enforces it.
- **Features cut for scope:** side-by-side comparison, prices measured from a named product ("cheaper than the Realme", "at a similar price") and sets for places ("something for the beach"). They worked, but each added router questions, regex overrides and state for little value in a minimal copilot.

How I worked: I used Claude Code as a pair programmer. I made the design calls listed above and checked them against the evals; it drafted most of the code and tests, which I reviewed and ran.

## Known limitations

- The test sets are mine; real shoppers phrase things none of them do.
- The model sees the latest message, the previous exchange and a one-line memory, not the whole history.
- The product type is decided by words and reviewed keywords; a product with an odd title and no keyword is missed.
- Ratings in DummyJSON are arbitrary, so "best rated first" is only as good as the data.
- Price scoping in code finds products by their English words, so in a Hebrew two-product request a bound the model copied onto both stays on both.
- A full reply takes about 4.4 s (cards about 2.5 s): three model calls per turn.
- Words the extractor returns stay in English, so a Hebrew chat's filter chip can read "white".
- Conversations can't be deleted or renamed; the title is the first message.
- `node:sqlite` is a release-candidate API; the in-process lock and rate limit assume one server process.

**With another week:** run the product and simulated-shopper evals on every prompt change and grow them from real conversations; a running summary of the whole conversation for the models; delete and rename conversations.

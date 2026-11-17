# Shopping copilot

A local chat for finding products in the DummyJSON catalog. You say what you want; the copilot works out what you mean, searches the catalog, and answers with a short sentence and product cards right in the chat. Conversations are saved on the server, so they survive a refresh and can be listed and continued.

## Setup and run

Requires Node 24 or newer.

```bash
cp server/.env.example server/.env    # Windows: copy server\.env.example server\.env
                                      # then put your OPENAI_API_KEY in server/.env
npm run setup                         # installs everything and builds the web app
npm start                             # open http://127.0.0.1:3000
```

The server also serves the built web app, so there's no separate client to start. No API key? `npm --prefix server run serve:fake` runs the same app on port 3100 with scripted models, so you can click around offline.

## Architecture and framework choice

```
browser (React) ──▶ Fastify server ──▶ one turn:
                                       1. router     (Decisions API)     what is this message asking for?
                                       2. extractor  (structured output) which products, which limits?
                                       3. retrieval  (plain code)        fetch, filter, sort, pick the cards
                                       4. reply      (model + check)     one sentence about the cards
                   SQLite ◀───────────  the conversation is saved
```

**The story.** I built it from scratch in TypeScript, with a small server (Fastify) and a React page. The main decision was to keep the model away from the facts. The model does what it is good at: understanding a messy sentence. Two small model calls run side by side. A router answers closed questions ("is this a new search, a change, a question about a card, or small talk?"). An extractor turns the sentence into fields ("laptop, under $1,000, cheapest first"). From there plain code takes over: it calls DummyJSON, filters, sorts and picks the cards. So every product, price and count on screen comes from code, not from the model. A last model call only words the reply, and any amount of money it writes is checked against the cards.

**Alternatives I rejected:**

- **An agent with tools** (the usual choice). It needs a model call to decide to search and another to read the results, on every turn. My two calls run in parallel, and small talk is answered in about 0.4 s. Also, the cases I care about ("cheaper" when nothing is cheaper, a price that belongs to one item of a list) become plain functions I can unit-test, not choices a model makes mid-loop.
- **Vercel AI SDK.** It is built around streaming text into the chat. I don't stream (below), so I'd use little of it and still write my own retry and conflict handling.
- **LangChain / LangGraph.** A big dependency to wrap a fixed sequence of four steps, and its saved state would duplicate my database.
- **assistant-ui / CopilotKit.** Chat shells built for streaming; I'd still hand-write every product widget.

**Why no streaming.** What the shopper waits for is the cards, and they exist only once the search is done. So the page polls the server for progress ("Understanding your request… → Searching the catalog…") and shows the cards the moment they are ready (about 2.3 s). The reply sentence follows about 1.5 s later. Polling also makes a refresh mid-turn simple: the reloaded page just asks about the same message again.

**The honest comparison.** I also built the simplest possible version: one model call with the whole 194-product catalog in the prompt. In simulated shopping sessions it did about as well as mine, and it was faster. I kept my design because it works against the API rather than a pasted catalog, it keeps working as the catalog grows, and nothing the shopper sees can be made up. If the catalog stayed this small and the simple version kept winning, I would switch.

## Retrieval strategy

**The story.** The extractor says *what* is wanted; code decides *how* to fetch it.

- **Endpoints.** If a category is known, it fetches `GET /products/category/{slug}`; otherwise the whole list, `GET /products?limit=0` (cached, 194 products). For one product's details ("tell me about the second one", or a click on a card) it calls `GET /products/{id}`. List calls use `select=` to fetch only the card fields.
- **Why code filters.** DummyJSON can't filter by price, stock or brand, and its `/products/search` matches the query as one exact phrase ("red lipstick" finds it, "lipstick red" doesn't). So code fetches the candidates and does the matching, filtering and sorting itself.
- **Matching words.** A word matches a product's title, tags, category, or a keyword list I generated once with the model and reviewed by hand ("drink" finds the juice, "earbuds" finds the AirPods).
- **When nothing matches exactly**, it keeps the product type and drops the extra words, and says so: "No white dress; here are other dresses." Price, stock, gender and the product type are never relaxed.

**Ambiguous: "something cheap and cool".** There's nothing concrete to search, so it shows a spread of well-rated products from different categories, cheapest first, with chips to narrow it ("Up to $50", "A gift", "Headphones"). "Cool" isn't searchable, so it's ignored; "cheap" becomes a sort. Gifts work the same way: ideas right away, with chips for budget and recipient, instead of a question first.

**Off-catalog: "a flight to Tokyo".** The router marks it as a service. No search is made, and the reply says it can't book trips and suggests things it can find. "Headphones and a flight to Tokyo" finds the headphones and says the flight is out of scope. A product the shop doesn't carry (a fridge) gets an honest "not found", never the nearest appliance.

**Multi-intent: "eggs, sunscreen, an iPhone case and a kettle".** Each item becomes its own search, run in parallel and shown as its own labelled group, up to six. The reply sums it up: "2 of 4 items found. No match for sunscreens and kettles." A limit belongs to the item it's written next to, so in "a laptop and a perfume under 50" only the perfume is under $50. Follow-ups can change one item ("a cheaper case"), remove one, or show more of one. If it's unclear which item is meant, it asks once.

**Follow-ups.** "Show more", "cheaper", "not Dior", "the second one", "and for a woman?" all change the search on screen. The rule is simple: a message replaces what it mentions and keeps the rest. "Cheaper" keeps the brand and color but moves the price below the cards shown.

## Conversation and state

**The story.** Conversations live in a SQLite file on the server. The browser keeps nothing but the conversation id in the URL (`/c/{id}`), so a refresh just loads it again. I chose the server over browser storage because clearing the browser shouldn't delete your chats, and the search state shouldn't be editable from the browser. A JSON file can be torn by a crash mid-write; Postgres is too much for one local file.

**Sending is safe to repeat.** Each message carries an id made in the browser. If the network drops and the browser sends it again, the server recognizes it: it returns the saved reply, or joins the turn still running. It never stores the message twice. If two tabs send at the same time, one wins, and the other gets the latest conversation back with its text still in the box.

**When things go wrong:**

- **Storage full:** the message isn't saved, the user keeps their text and can try again.
- **Corrupted file:** checked at startup. A corrupt database is moved aside, a fresh one starts, and the sidebar says older history was set aside. A single unreadable message shows "Couldn't load these results" and the rest of the chat still opens.
- **The user clears browser storage mid-conversation:** nothing is lost, because the server holds everything.

## Evaluation

**The story.** Three layers of tests check that it *works*; two evals measure whether it's *good*.

```bash
npm test                                      # server + web tests, offline
npx --prefix web playwright install chromium  # once
npm run e2e                                   # browser tests
npm --prefix server run eval:product          # paid, live models
npm --prefix server run eval:sim              # paid, simulated shoppers
```

1. **Server tests (352, offline):** the real pipeline, real filtering over a saved copy of the catalog, and scripted model answers. They cover the assignment's examples, lists, follow-ups, price rules, retries, the two-tab race and storage failures.
2. **Web tests (99):** every card, chip, error and loading state, and how the page reacts to each server response.
3. **Browser tests (13):** the real server in Chromium. They cover refreshing mid-answer, clicking an old card, the phone layout, and accessibility checks.
4. **Product eval (live models).** Tests with scripted answers prove the plumbing, but not whether the real model understands real phrasing. This eval sends labelled conversations through the whole app with the live model. It checks what the shopper actually gets: the right kind of answer, the right cards, no cards that shouldn't be there, and no invented prices. It's how I decided every prompt change and every rule: a change stayed only if it helped here. One set was written by an agent that never saw the code, so I can tell real improvement from tuning to my own examples.
5. **Simulated shoppers.** Single turns don't show whether a whole conversation gets somewhere. Here a model plays a shopper with a hidden goal and chats until it finds the product or gives up. I run it against my pipeline and against the simplest alternative (one model call with the whole catalog in the prompt), to check that the design earns its complexity.

The reports from the latest runs are in `server/eval/`.

**What it catches:** a price applied to the wrong item, lost history on refresh, duplicate messages, broken cards, a reply that invents a price, a fallback that drops what the user asked for.
**What slips through:** phrasings unlike my test sets, a wrong product name or rating in the reply sentence (only prices are checked), whether results feel "cool", visual layout, and browsers other than Chromium.

## What I tried and abandoned

- **A seven-step fallback when nothing matched.** Four of its steps almost never helped (2 times in 125), and one dropped the very words that defined the product. One step is left.
- **Asking a question first** for vague requests and gifts. Ideas plus chips do the same job without a 4-second round trip.
- **Hebrew support.** It doubled every template and rule for something the assignment didn't ask for, so I cut it.
- **Embeddings** for matching words to products. Only one model was allowed, so a reviewed keyword list replaced them.
- **Templates for every reply.** They read like a search report, so the model now words the sentence from facts code already decided.

I used Claude Code as a pair programmer: I made the design calls and checked them against the evals; it drafted most of the code and tests, which I reviewed and ran.

## Known limitations

- The model sees the latest message, the previous exchange and a short memory, not the whole conversation.
- A product with an unusual title and no matching keyword can be missed.
- A full reply takes about 4 s; the cards come at about 2.3 s.
- Ratings in DummyJSON are arbitrary, so "best rated" is only as good as the data.
- Conversations can't be deleted or renamed.
- It's built for one local server process (the in-process lock and rate limit assume it).

**With another week:** run the evals on every prompt change and grow them from real conversations; give the models a running summary of the whole conversation; put a real search engine in front of the filters for a bigger catalog; delete and rename conversations; a cart; more languages; and visual polish (original prices on discounted cards, a busy marker in the sidebar).

# Product eval report

- Date: 2026-11-17 20:06 UTC
- Prompts: router router.v10, extract extract.v14, prose prose.v10
- Sets: holdout; runs: 3; turns scored: 60; judge: on
- Turn pass rate (right action, precision ≥ 0.75 and recall ≥ 0.5 where labelled, no forbidden card, nothing invented): **83%**

## Scorecard against the A- targets

| Measure | Value | A- target | |
| --- | ---: | ---: | :-: |
| precision@shown (labelled turns) | 0.97 | ≥ 0.85 | ✅ |
| recall@shown (labelled turns) | 0.96 | ≥ 0.80 | ✅ |
| forbidden cards shown | 0 | 0 | ✅ |
| right action | 85% | ≥ 95% | ❌ |
| dead ends ("which one?" when an action was obvious) | 0 | 0 | ✅ |
| invented prices or titles in replies | 0 | 0 | ✅ |
| vague requests handled (clarify or coherent) | n/a | 100% | – |
| judge: overall (1–5) | 4.22 | ≥ 4.3 | ❌ |
| time to cards p50 / p90 | 2.3 s / 3.1 s | ≤ 2.5 s / 3.5 s | ✅ |
| full reply p50 / p90 | 3.9 s / 4.8 s | p50 ≤ 4 s | ✅ |

Judge detail (mean 1–5): answers 4.40, accurate 4.95, honest 4.87, clear 4.73, overall 4.22. The judge is gpt-6-luna grading gpt-6-luna (the only allowed model): a second opinion, not a measurement. Reply writer p50 1.6 s. "Time to cards" is when retrieval finished and the cards appear (cards first).

## holdout

| Case | Turn | Message | Expected | Got (per run) | P | R | Judge | Pass |
| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: |
| s02 ✍ | 1 | eyeshadow | results | results, results, results | 1.00 | 1.00 | 5.0 | 100% |
| s01 ✍ | 1 | do you have a rolling pin for dough? | results | results, results, results | 1.00 | 1.00 | 5.0 | 100% |
| s04 ✍ | 1 | selfie stick | results | results, results, results | 1.00 | 0.50 | 5.0 | 100% |
| s03 ✍ | 1 | cat food | results | results, results, results | 1.00 | 1.00 | 4.7 | 100% |
| s05 ✍ | 1 | a microwave please | results | results, results, results | 1.00 | 1.00 | 5.0 | 100% |
| s06 ✍ | 1 | I need a lunch box to take to work | results | results, results, results | 1.00 | 1.00 | 4.7 | 100% |
| s07 ✍ | 1 | a serving tray for guests | results | results, results, results | 1.00 | 1.00 | 5.0 | 100% |
| s08 ✍ | 1 | honey for my tea | results | results, results, results | 1.00 | 1.00 | 5.0 | 100% |
| s09 ✍ | 1 | green earrings | results | results, results, results | 1.00 | 1.00 | 5.0 | 100% |
| s10 ✍ | 1 | white sneakers with red | results | results, results, results | 1.00 | 1.00 | 5.0 | 100% |
| s12 ✍ | 1 | bro, need a perfume for like $80 | results | results, results, results | 0.75 | 1.00 | 4.7 | 100% |
| s11 ✍ | 1 | a corset with a skirt | results | results, results, results | 1.00 | 1.00 | 4.7 | 100% |
| s15 ✍ | 1 | an air conditioner for the living room | miss | miss, miss, miss | n/a | n/a | 2.0 | 100% |
| s14 ✍ | 1 | a speaker with Alexa | results | results, results, results | 1.00 | 1.00 | 4.7 | 100% |
| s13 ✍ | 1 | a wearable that tracks fitness, under $400 | results | results, results, results | 0.83 | 1.00 | 4.0 | 67% |
| s16 ✍ | 1 | soccer cleats | miss | results, results, results | n/a | n/a | 3.3 | 0% |
| s17 ✍ | 1 | a treadmill for home | miss | miss, miss, miss | n/a | n/a | 3.7 | 100% |
| s20 ✍ | 1 | how do I return something, and can I get a refund? | service | service, service, service | n/a | n/a | 2.0 | 100% |
| s18 ✍ | 1 | something for my grandma's 80th birthday | clarify | results, results, results | n/a | n/a | 3.0 | 0% |
| s19 ✍ | 1 | I have 200 dollars, what should I buy? | clarify | results, results, results | n/a | n/a | 3.0 | 0% |

## Failures (first run of each)

- **s16#1** "soccer cleats": action results (expected miss)
  - reply: I couldn’t find soccer cleats, but I found Nike Baseball Cleats for $79.99.
  - cards: Nike Baseball Cleats $79.99
- **s18#1** "something for my grandma's 80th birthday": action results (expected clarify)
  - reply: Here are a few gift ideas, including a Heshe Women's Leather Bag for $129.99 and Calvin Klein Heel Shoes for $79.99. Let me know if you have a budget or a type of gift in mind.
  - cards: Heshe Women's Leather Bag $129.99 · Calvin Klein Heel Shoes $79.99 · Powder Canister $14.99 · Green and Black Glasses $34.99
- **s19#1** "I have 200 dollars, what should I buy?": action results (expected clarify)
  - reply: There are 117 products priced up to $200; the first shown is the Amazon Echo Plus at $99.99.
  - cards: Amazon Echo Plus $99.99 · Lunch Box $12.99 · Heshe Women's Leather Bag $129.99 · Calvin Klein Heel Shoes $79.99
- **s13#1** "a wearable that tracks fitness, under $400": precision 0.50
  - reply: Apple Watch Series 4 Gold is listed for $349.99, under $400. I also found Protein Powder, but it isn’t a wearable.
  - cards: Protein Powder $19.99 · Apple Watch Series 4 Gold $349.99

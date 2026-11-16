# Product eval report

- Date: 2026-11-16 11:53 UTC
- Prompts: router router.v6, extract extract.v10, prose prose.v8
- Sets: holdout; runs: 1; turns scored: 20; judge: on
- Turn pass rate (right action, precision ≥ 0.75 and recall ≥ 0.5 where labelled, no forbidden card, nothing invented): **90%**

## Scorecard against the A- targets

| Measure | Value | A- target | |
| --- | ---: | ---: | :-: |
| precision@shown (labelled turns) | 1.00 | ≥ 0.85 | ✅ |
| recall@shown (labelled turns) | 0.96 | ≥ 0.80 | ✅ |
| forbidden cards shown | 0 | 0 | ✅ |
| right action | 90% | ≥ 95% | ❌ |
| dead ends ("which one?" when an action was obvious) | 0 | 0 | ✅ |
| invented prices or titles in replies | 0 | 0 | ✅ |
| vague requests handled (clarify or coherent) | n/a | 100% | – |
| judge: overall (1–5) | 4.30 | ≥ 4.3 | ✅ |
| time to cards p50 / p90 | 2.5 s / 4.4 s | ≤ 2.5 s / 3.5 s | ❌ |
| full reply p50 / p90 | 4.4 s / 6.4 s | p50 ≤ 4 s | ❌ |

Judge detail (mean 1–5): answers 4.45, accurate 4.80, honest 4.85, language 4.90, overall 4.30. Reply writer p50 1.8 s. "Time to cards" is when retrieval finished; today the cards are only sent with the full reply.

## Judge calibration

No hand grades match this run yet. Grade replies in the labelling page (Grade tab), then rerun.

## holdout

| Case | Turn | Message | Expected | Got (per run) | P | R | Judge | Pass |
| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: |
| s03 ✍ | 1 | אוכל לחתול | results | results | 1.00 | 1.00 | 5.0 | 100% |
| s02 ✍ | 1 | צלליות לעיניים | results | results | 1.00 | 1.00 | 5.0 | 100% |
| s04 ✍ | 1 | מקל סלפי | results | results | 1.00 | 0.50 | 5.0 | 100% |
| s01 ✍ | 1 | יש לכם מערוך לבצק? | results | results | 1.00 | 1.00 | 5.0 | 100% |
| s07 ✍ | 1 | a serving tray for guests | results | results | 1.00 | 1.00 | 4.0 | 100% |
| s06 ✍ | 1 | I need a lunch box to take to work | results | results | 1.00 | 1.00 | 5.0 | 100% |
| s05 ✍ | 1 | מיקרוגל בבקשה | results | results | 1.00 | 1.00 | 5.0 | 100% |
| s08 ✍ | 1 | דבש לתה | results | results | 1.00 | 1.00 | 5.0 | 100% |
| s09 ✍ | 1 | עגילים ירוקים | results | results | 1.00 | 1.00 | 5.0 | 100% |
| s11 ✍ | 1 | קורסט עם חצאית | results | results | 1.00 | 1.00 | 5.0 | 100% |
| s10 ✍ | 1 | סניקרס לבנות עם אדום | results | results | 1.00 | 1.00 | 3.0 | 100% |
| s12 ✍ | 1 | אחי בושם בשביל 300 שקל | results | results | 1.00 | 1.00 | 4.0 | 100% |
| s13 ✍ | 1 | a wearable that tracks fitness, under $400 | results | results | 1.00 | 1.00 | 4.0 | 100% |
| s14 ✍ | 1 | רמקול עם אלקסה | results | results | 1.00 | 1.00 | 5.0 | 100% |
| s15 ✍ | 1 | מזגן לסלון | miss | miss | n/a | n/a | 4.0 | 100% |
| s18 ✍ | 1 | משהו לסבתא ליום הולדת 80 | clarify | clarify | n/a | n/a | 4.0 | 100% |
| s17 ✍ | 1 | a treadmill for home | miss | miss | n/a | n/a | 4.0 | 100% |
| s16 ✍ | 1 | נעלי כדורגל עם פקקים | miss | results | n/a | n/a | 2.0 | 0% |
| s19 ✍ | 1 | I have 200 dollars, what should I buy? | clarify | results | n/a | n/a | 4.0 | 0% |
| s20 ✍ | 1 | איך מחזירים מוצר ואפשר החזר כספי? | service | service | n/a | n/a | 3.0 | 100% |

## Failures (first run of each)

- **s16#1** "נעלי כדורגל עם פקקים": action results (expected miss)
  - reply: לא נמצאו נעלי כדורגל עם פקקים; הנה Nike Baseball Cleats, נעלי בייסבול לגברים ב-$79.99.
  - cards: Nike Baseball Cleats $79.99
- **s19#1** "I have 200 dollars, what should I buy?": action results (expected clarify)
  - reply: You have plenty of options under $200, including the Amazon Echo Plus for $99.99 or the Heshe Women's Leather Bag for $129.99. There are 117 products to choose from.
  - cards: Amazon Echo Plus $99.99 · Lunch Box $12.99 · Heshe Women's Leather Bag $129.99 · Calvin Klein Heel Shoes $79.99

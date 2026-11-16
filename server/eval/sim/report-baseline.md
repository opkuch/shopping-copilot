# Simulated-user eval report

- Date: 2026-11-16 08:08 UTC
- Target: baseline; runs per goal: 3; conversations: 84

| Measure | Value |
| --- | ---: |
| task success (all goals) | **98%** |
| task success, standard goals / hard goals | 96% / 100% |
| found the right product (possible goals) | 97% |
| right product was on screen at some point | 99% |
| turns to success (mean, successful possible goals) | 2.0 |
| turn the right product first appeared (mean) | 1.5 |
| shopper gave up or ran out of turns | 0% |
| told "not available" for a product the shop has | 1 |
| honest "we don't sell that" (impossible goals) | 100% |
| errors | 0 |
| assistant turn latency p50 | 2.7 s |

## Per goal

| Goal | Success | Outcomes | Turns |
| --- | ---: | --- | --- |
| h01 | 100% | found:81, found:81, found:81 | 4, 5, 4 |
| h02 | 100% | found:160, found:160, found:160 | 1, 1, 1 |
| h03 | 100% | found:128, found:128, found:128 | 2, 2, 3 |
| h04 | 100% | found:131, found:131, found:131 | 2, 2, 2 |
| h05 | 100% | found:108, found:108, found:108 | 1, 1, 1 |
| h06 | 100% | found:8+90, found:8+90, found:8+90 | 1, 1, 1 |
| h07 | 100% | found:52, found:52, found:52 | 4, 3, 4 |
| h08 | 100% | found:194, found:194, found:194 | 3, 3, 3 |
| h09 | 100% | found:173, found:173, found:173 | 1, 1, 1 |
| h10 | 100% | found:123, found:123, found:123 | 2, 2, 2 |
| h11 | 100% | found:93, found:93, found:93 | 2, 4, 4 |
| h12 | 100% | found:62, found:62, found:62 | 2, 2, 2 |
| s01 | 100% | found:8, found:8, found:8 | 2, 2, 2 |
| s02 | 100% | found:131, found:131, found:131 | 1, 2, 2 |
| s03 | 67% | found:90, found:90, not_available | 1, 6, 3 |
| s04 | 100% | found:100, found:100, found:100 | 2, 2, 2 |
| s05 | 100% | found:80, found:80, found:80 | 1, 1, 2 |
| s06 | 100% | found:177, found:177, found:177 | 2, 2, 2 |
| s07 | 100% | not_available, not_available, not_available | 1, 1, 1 |
| s08 | 100% | found:161, found:161, found:161 | 2, 2, 2 |
| s09 | 100% | found:93, found:93, found:93 | 1, 1, 1 |
| s10 | 67% | found:158, found:157, found:157 | 2, 3, 3 |
| s11 | 100% | found:51, found:51, found:51 | 1, 1, 1 |
| s12 | 100% | found:173, found:7, found:173 | 2, 3, 2 |
| s13 | 100% | found:45, found:45, found:45 | 1, 1, 2 |
| s14 | 100% | found:140, found:140, found:140 | 1, 3, 1 |
| s15 | 100% | not_available, not_available, not_available | 1, 1, 1 |
| s16 | 100% | found:124+133, found:124+133, found:122+127 | 3, 2, 2 |

## Failed conversations (first of each goal)

### s03 run 3: not_available

1. **User:** looking for gym sneakers for myself under 100
   **Bot:** Are you looking for men’s or women’s sneakers?
   Cards: none
2. **User:** mens sneakers please
   **Bot:** Here are men’s sneakers under $100:
   Cards: [90] Puma Future Rider Trainers $89.99 · [89] Nike Baseball Cleats $79.99
3. **User:** the puma ones look more casual than gym shoes do you have any training sneakers
   **Bot:** Sorry, we don’t have men’s training sneakers under $100. The athletic sneakers we carry are over budget.
   Cards: none

### s10 run 1: found (picked 158)

1. **User:** Hi, I’m looking for sunglasses. What do you have?
   **Bot:** We have these sunglasses: - Black Sun Glasses (rating 4.41) - Green and Black Glasses (rating 4.55) - Classic Sun Glasses (rating 3.86) - Sunglasses (rating 3.02)
   Cards: [154] Black Sun Glasses $29.99 · [156] Green and Black Glasses $34.99 · [155] Classic Sun Glasses $24.99 · [158] Sunglasses $22.99
2. **User:** Actually, what women’s bags do you have?
   **Bot:** We have these women’s bags, best rated first:
   Cards: [173] Heshe Women's Leather Bag $129.99 · [175] White Faux Leather Backpack $39.99 · [172] Blue Women's Handbag $49.99 · [176] Women Handbag Black $59.99


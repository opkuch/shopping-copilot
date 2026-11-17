# Simulated-user eval report

- Date: 2026-11-17 20:00 UTC
- Target: baseline; runs per goal: 3; conversations: 78

| Measure | Value |
| --- | ---: |
| task success (all goals) | **92%** |
| task success, standard goals / hard goals | 89% / 97% |
| found the right product (possible goals) | 92% |
| right product was on screen at some point | 100% |
| turns to success (mean, successful possible goals) | 2.0 |
| turn the right product first appeared (mean) | 1.3 |
| shopper gave up or ran out of turns | 0% |
| told "not available" for a product the shop has | 3 |
| honest "we don't sell that" (impossible goals) | 100% |
| errors | 0 |
| assistant turn latency p50 | 2.5 s |

## Per goal

| Goal | Success | Outcomes | Turns |
| --- | ---: | --- | --- |
| h01 | 100% | found:81, found:81, found:81 | 5, 4, 4 |
| h02 | 100% | found:160, found:160, found:160 | 1, 1, 1 |
| h04 | 100% | found:131, found:131, found:131 | 2, 2, 2 |
| h05 | 100% | found:108, found:108, found:108 | 1, 2, 1 |
| h06 | 100% | found:9+90, found:8+90, found:9+90 | 1, 1, 1 |
| h07 | 100% | found:52, found:52, found:52 | 4, 3, 2 |
| h08 | 100% | found:194, found:194, found:194 | 3, 3, 3 |
| h09 | 100% | found:173, found:173, found:173 | 1, 1, 1 |
| h10 | 100% | found:123, found:123, found:123 | 2, 2, 2 |
| h11 | 100% | found:93, found:93, found:93 | 4, 4, 3 |
| h12 | 67% | found:20, found:62, found:62 | 2, 2, 2 |
| s01 | 100% | found:8, found:8, found:8 | 2, 2, 2 |
| s02 | 100% | found:131, found:131, found:131 | 2, 2, 1 |
| s03 | 33% | not_available, found:90, not_available | 2, 2, 2 |
| s04 | 100% | found:100, found:100, found:100 | 2, 2, 2 |
| s05 | 100% | found:80, found:80, found:80 | 2, 1, 2 |
| s06 | 100% | found:177, found:177, found:177 | 2, 2, 2 |
| s07 | 100% | not_available, not_available, not_available | 1, 2, 1 |
| s08 | 100% | found:161, found:161, found:161 | 2, 2, 2 |
| s09 | 100% | found:93, found:93, found:93 | 1, 2, 2 |
| s10 | 67% | found:158, found:155, found:158 | 2, 3, 4 |
| s11 | 100% | found:51, found:51, found:51 | 1, 1, 1 |
| s12 | 67% | found:173, found:45, found:173 | 1, 3, 2 |
| s13 | 100% | found:45, found:45, found:45 | 1, 2, 1 |
| s14 | 67% | not_available, found:140, found:140 | 4, 1, 1 |
| s15 | 100% | not_available, not_available, not_available | 1, 1, 1 |

## Failed conversations (first of each goal)

### h12 run 1: found (picked 20)

1. **User:** What kitchen stuff do you have under $10?
   **Bot:** Here are some kitchen items under $10, best-rated first:
   Cards: [62] Ice Cube Tray $5.99 · [54] Citrus Squeezer Yellow $8.99 · [49] Black Aluminium Cup $5.99 · [70] Red Tongs $6.99
2. **User:** Which one is the highest-rated kitchen item under $10 in the whole shop, not just among these?
   **Bot:** Cooking Oil is the highest-rated kitchen-related item under $10 in the shop (4.8 rating).
   Cards: [20] Cooking Oil $4.99

### s03 run 1: not_available

1. **User:** looking for gym sneakers for myself under 100
   **Bot:** The closest match is the Puma Future Rider Trainers, listed in men's shoes. Is that suitable for you?
   Cards: [90] Puma Future Rider Trainers $89.99
2. **User:** i need something made for workouts not just casual sneakers
   **Bot:** We don’t have workout-specific sneakers under $100 in the catalog. The athletic sneakers listed are over your budget.
   Cards: none

### s10 run 2: found (picked 155)

1. **User:** Hi, I’m looking for sunglasses.
   **Bot:** Here are a few sunglasses options, ranked by rating:
   Cards: [156] Green and Black Glasses $34.99 · [154] Black Sun Glasses $29.99 · [155] Classic Sun Glasses $24.99 · [158] Sunglasses $22.99
2. **User:** Actually, could you show me some women's bags?
   **Bot:** Here are some women’s bags, ranked by rating.
   Cards: [173] Heshe Women's Leather Bag $129.99 · [175] White Faux Leather Backpack $39.99 · [172] Blue Women's Handbag $49.99 · [176] Women Handbag Black $59.99
3. **User:** Ok back to the sunglasses—what's the cheapest one that's in stock?
   **Bot:** The cheapest in-stock sunglasses are Classic Sun Glasses for $24.99 (ID 155).
   Cards: [155] Classic Sun Glasses $24.99

### s12 run 2: found (picked 45)

1. **User:** valentine's day gift
   **Bot:** Here are a few Valentine’s Day gift ideas: a leather bag, perfume, or elegant jewelry. Are you shopping for someone in particular, or do you have a budget in mind?
   Cards: [173] Heshe Women's Leather Bag $129.99 · [7] Chanel Coco Noir Eau De $129.99 · [182] Green Crystal Earring $29.99 · [186] Calvin Klein Heel Shoes $79.99
2. **User:** For my girlfriend, up to $200. Not jewelry—she has plenty. Could you show me some other ideas?
   **Bot:** Sure—here are a few alternatives under $200, excluding jewelry and the items I mentioned before:
   Cards: [180] Dress Pea $49.99 · [181] Marni Red & Black Suit $179.99 · [156] Green and Black Glasses $34.99 · [154] Black Sun Glasses $29.99
3. **User:** Not really what I’m looking for. Could you show me something like skincare, a cozy home gift, or a fun experience?
   **Bot:** We don’t sell experiences, but here are some skincare and cozy-home ideas under $200:
   Cards: [119] Olay Ultra Moisture Shea Butter Body Wash $12.99 · [45] House Showpiece Plant $39.99 · [44] Family Tree Photo Frame $29.99 · [47] Table Lamp $49.99

### s14 run 1: not_available

1. **User:** I’m looking for a basketball for my 10-year-old son.
   **Bot:** We have one basketball option. What size does he need?
   Cards: [140] Basketball $14.99
2. **User:** He’s 10, so probably a size 5. Is that one available in size 5?
   **Bot:** The catalog doesn’t list a size for the basketball, so I can’t confirm whether it’s size 5. It is in stock, though.
   Cards: [140] Basketball $14.99 · detail [140]
3. **User:** Do you have a youth size 5 basketball for him?
   **Bot:** I can’t confirm the size: our catalog only lists a Basketball without size details. It is in stock.
   Cards: [140] Basketball $14.99
4. **User:** Could you check with someone whether it’s a size 5, or see if you have another youth basketball?
   **Bot:** I can’t check with staff, and the catalog doesn’t list basketball sizes. We only have the Basketball listed; there isn’t another basketball option.
   Cards: [140] Basketball $14.99


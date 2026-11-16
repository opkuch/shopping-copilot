# Product eval report

- Date: 2026-11-16 12:32 UTC
- Prompts: router router.v6, extract extract.v11, prose prose.v8
- Sets: queries, dialogues, vague; runs: 1; turns scored: 182; judge: on
- Turn pass rate (right action, precision ≥ 0.75 and recall ≥ 0.5 where labelled, no forbidden card, nothing invented): **90%**

## Scorecard against the A- targets

| Measure | Value | A- target | |
| --- | ---: | ---: | :-: |
| precision@shown (labelled turns) | 0.95 | ≥ 0.85 | ✅ |
| recall@shown (labelled turns) | 0.93 | ≥ 0.80 | ✅ |
| forbidden cards shown | 3 | 0 | ❌ |
| right action | 95% | ≥ 95% | ✅ |
| dead ends ("which one?" when an action was obvious) | 1 | 0 | ❌ |
| invented prices or titles in replies | 0 | 0 | ✅ |
| vague requests handled (clarify or coherent) | 100% | 100% | ✅ |
| judge: overall (1–5) | 4.34 | ≥ 4.3 | ✅ |
| time to cards p50 / p90 | 2.6 s / 3.8 s | ≤ 2.5 s / 3.5 s | ❌ |
| full reply p50 / p90 | 4.7 s / 5.8 s | p50 ≤ 4 s | ❌ |

Judge detail (mean 1–5): answers 4.46, accurate 4.75, honest 4.79, language 4.95, overall 4.34. Reply writer p50 1.9 s. "Time to cards" is when retrieval finished; today the cards are only sent with the full reply.

## Judge calibration

No hand grades match this run yet. Grade replies in the labelling page (Grade tab), then rerun.

## queries

| Case | Turn | Message | Expected | Got (per run) | P | R | Judge | Pass |
| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: |
| c01 | 1 | אני מחפש מחשב נייד עד 1500 דולר | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c03 | 1 | שעון יד לאישה עד 200 | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c02 | 1 | בושם לגבר | results | results | 1.00 | 1.00 | 4.0 | 100% |
| c04 | 1 | נעלי ספורט | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c06 | 1 | אוזניות אלחוטיות | results | results | 1.00 | 0.67 | 5.0 | 100% |
| c07 | 1 | כדור כדורסל | results | results | 0.50 | 1.00 | 4.0 | 0% |
| c05 | 1 | משקפי שמש זולים | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c08 | 1 | משהו לבית | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c10 | 1 | טלפון סמסונג | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c11 | 1 | מוצרי אפל | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c09 | 1 | רהיטים לסלון | results | results | 0.25 | 0.25 | 3.0 | 0% |
| c12 | 1 | תיק יד שחור מעור | results | results | 0.67 | 1.00 | 5.0 | 0% |
| c13 | 1 | קרם לחות לפנים | results | results | 1.00 | 1.00 | 4.0 | 100% |
| c15 | 1 | עגילים | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c14 | 1 | שמלה לבנה | results | results | 1.00 | 1.00 | 4.0 | 100% |
| c16 | 1 | שרשרת זהב | miss | miss | n/a | n/a | 4.0 | 100% |
| c18 | 1 | סכין למטבח | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c17 | 1 | מחבת לבישול | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c19 | 1 | קפה | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c20 | 1 | אוכל לכלב | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c21 | 1 | רכב משפחתי | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c22 | 1 | טאבלט של סמסונג עד 400 | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c23 | 1 | מטען לאייפון | results | results | 1.00 | 0.33 | 5.0 | 0% |
| c24 | 1 | שעון חכם | results | results | 1.00 | 1.00 | 4.0 | 100% |
| c26 | 1 | a gaming laptop under $1000 | miss | miss | n/a | n/a | 5.0 | 100% |
| c25 | 1 | חולצה משובצת לגבר | results | results | 1.00 | 0.33 | 5.0 | 0% |
| c27 | 1 | red lipstick | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c29 | 1 | something to drink | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c28 | 1 | cheap tennis gear | results | results | 1.00 | 1.00 | 4.0 | 100% |
| c31 | 1 | a Rolex for men | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c30 | 1 | running shoes | results | results | 1.00 | 0.75 | 4.0 | 100% |
| c33 | 1 | a sofa | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c32 | 1 | an iPhone under 300 | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c35 | 1 | Dior perfume | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c34 | 1 | wireless charger | results | results | 1.00 | 1.00 | 5.0 | 100% |
| c37 | 1 | book me a hotel in Eilat | service | service | n/a | n/a | 4.0 | 100% |
| c39 | 1 | hi there! | chat | chat | n/a | n/a | 4.0 | 100% |
| c38 | 1 | what's 17 times 23? | off_topic | off_topic | n/a | n/a | 5.0 | 100% |
| c36 | 1 | a cricket bat and a helmet | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a02 ✍ | 1 | airpods יש? | results | results | 1.00 | 0.50 | 5.0 | 100% |
| c40 | 1 | תיק גב לבית ספר | results | results | 1.00 | 1.00 | 3.0 | 100% |
| a01 ✍ | 1 | אייפון זול בבקשה | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a03 ✍ | 1 | נעלי נייקי לגבר | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a06 ✍ | 1 | תיק של פראדה לאשתי | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a05 ✍ | 1 | תביא לי משהו של דיור | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a07 ✍ | 1 | עגילים לאשתי | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a04 ✍ | 1 | שעון רולקס לבעלי | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a09 ✍ | 1 | which laptop is the best rated | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a10 ✍ | 1 | מקרר | miss | miss | n/a | n/a | 4.0 | 100% |
| a11 ✍ | 1 | פלייסטיישן | miss | miss | n/a | n/a | 4.0 | 100% |
| a08 ✍ | 1 | הסמסונג הכי זול שיש לכם | results | results | 1.00 | 1.00 | 4.0 | 100% |
| a13 ✍ | 1 | do you sell an electric kettle? | miss | miss | n/a | n/a | 5.0 | 100% |
| a12 ✍ | 1 | נעלי עקב לגבר | miss | results | n/a | n/a | 4.0 | 0% |
| a15 ✍ | 1 | שמלת ערב שחורה | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a14 ✍ | 1 | שמלה לילדה בת 6 | results | results | 0.25 | 1.00 | 4.0 | 0% |
| a16 ✍ | 1 | men's shirt under $25 | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a17 ✍ | 1 | כדורגל | results | results | 0.50 | 1.00 | 4.0 | 0% |
| a19 ✍ | 1 | hand blender | results | results | 1.00 | 0.50 | 5.0 | 100% |
| a18 ✍ | 1 | מחבת לטיגון | results | results | 1.00 | 1.00 | 4.0 | 100% |
| a20 ✍ | 1 | מיטה זוגית | results | results | 1.00 | 1.00 | 4.0 | 100% |
| a21 ✍ | 1 | office chair | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a22 ✍ | 1 | motorcycle under $5000 | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a23 ✍ | 1 | טאבלט סמסונג | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a24 ✍ | 1 | רמקול חכם לסלון | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a26 ✍ | 1 | mascara | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a25 ✍ | 1 | סוללה ניידת לטלפון | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a27 ✍ | 1 | לק אדום | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a28 ✍ | 1 | אני רוצה סמסונג שיש במלאי | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a31 ✍ | 1 | היי מה נשמע | chat | chat | n/a | n/a | 3.0 | 100% |
| a29 ✍ | 1 | תביא לי טלפון עד 1000 שקל | results | results | 1.00 | 1.00 | 4.0 | 100% |
| a32 ✍ | 1 | תזמין לי טיסה לאילת | service | service | n/a | n/a | 5.0 | 100% |
| a33 ✍ | 1 | אפשר משלוח עד הבית מחר בבוקר? | service | service | n/a | n/a | 4.0 | 100% |
| a35 ✍ | 1 | מה מזג האוויר מחר בחיפה | off_topic | off_topic | n/a | n/a | 5.0 | 100% |
| a34 ✍ | 1 | write me a poem about cats | off_topic | off_topic | n/a | n/a | 4.0 | 100% |
| a30 ✍ | 1 | שעון לגבר בשביל 300 שקל | results | miss | 0.00 | 0.00 | 4.0 | 0% |
| a38 ✍ | 1 | body lotion for men | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a36 ✍ | 1 | אייפון ואוזניות עד 200 דולר | results | results | 0.50 | 1.00 | 2.0 | 0% |
| a37 ✍ | 1 | משקפי שמש ותיק יד לאישה | results | results | 1.00 | 1.00 | 5.0 | 100% |
| a39 ✍ | 1 | בושם הכי זול | results | results | 1.00 | 1.00 | 4.0 | 100% |
| a40 ✍ | 1 | נעליים אדומות | results | results | 1.00 | 0.25 | 5.0 | 0% |
| x01 ✍ | 1 | יש לכם בלנדר? משהו לשייקים | results | results | 1.00 | 1.00 | 5.0 | 100% |
| x02 ✍ | 1 | אחי אני מחפש אופנוע עד 4000 דולר | results | results | 1.00 | 1.00 | 5.0 | 100% |
| x03 ✍ | 1 | מנורה לשולחן ליד המיטה | results | results | 1.00 | 1.00 | 5.0 | 100% |
| x04 ✍ | 1 | מיטה זוגית חדשה | results | results | 1.00 | 1.00 | 3.0 | 100% |
| x05 ✍ | 1 | ויוו עד 300 דולר, מה יש? | results | results | 1.00 | 1.00 | 5.0 | 100% |
| x07 ✍ | 1 | אוזניות גדולות כאלה שמכסות את כל האוזן | results | results | 1.00 | 1.00 | 5.0 | 100% |
| x06 ✍ | 1 | נעלי עקב לאירוע | results | results | 1.00 | 1.00 | 5.0 | 100% |
| x08 ✍ | 1 | איזה תיק לאישה הכי מדורג אצלכם | results | results | 1.00 | 1.00 | 5.0 | 100% |
| x09 ✍ | 1 | רמקול חכם לסלון | results | results | 1.00 | 1.00 | 5.0 | 100% |
| x10 ✍ | 1 | שמלת ערב שחורה ארוכה | results | results | 1.00 | 1.00 | 4.0 | 100% |
| x11 ✍ | 1 | יש מכונת כביסה? בא לי משהו עד 2000 שקל | miss | miss | n/a | n/a | 4.0 | 100% |
| x12 ✍ | 1 | מזרן אורתופדי | miss | miss | n/a | n/a | 5.0 | 100% |
| x15 ✍ | 1 | ההזמנה שלי לא הגיעה כבר שבועיים, איפה היא?? | service | service | n/a | n/a | 4.0 | 100% |
| x13 ✍ | 1 | צריכה משהו לחתונה של חברה | clarify | clarify | n/a | n/a | 4.0 | 100% |
| x16 ✍ | 1 | do you have the Nike Air Jordan? | results | results | 1.00 | 1.00 | 5.0 | 100% |
| x18 ✍ | 1 | the most expensive men's Rolex | results | results | 1.00 | 1.00 | 5.0 | 100% |
| x17 ✍ | 1 | golf balls and clubs | results | results | 1.00 | 1.00 | 4.0 | 100% |
| x19 ✍ | 1 | PlayStation 5 console | miss | miss | n/a | n/a | 5.0 | 100% |
| x20 ✍ | 1 | protein powder under $25 | results | results | 1.00 | 1.00 | 5.0 | 100% |

## dialogues

| Case | Turn | Message | Expected | Got (per run) | P | R | Judge | Pass |
| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: |
| d01 | 1 | מה הטלפון הכי זול? | results | results | 1.00 | 1.00 | 5.0 | 100% |
| d04 | 1 | שעונים לגברים | results | results | 1.00 | 1.00 | 4.0 | 100% |
| d03 | 1 | טלפונים של סמסונג | results | results | 1.00 | 1.00 | 4.0 | 100% |
| d02 | 1 | מחשב נייד ובושם עד 50 | results | results | 1.00 | 0.83 | 4.0 | 100% |
| d01 | 2 | אני רוצה את הכי זול | detail | detail | n/a | n/a | 4.0 | 100% |
| d04 | 2 | תראה עוד | more | more | n/a | n/a | 3.0 | 100% |
| d03 | 2 | מה ההבדל בין הראשון לשני? | compare | compare | n/a | n/a | 4.0 | 100% |
| d02 | 2 | תוזיל | ask_group | ask_group | n/a | n/a | 3.0 | 100% |
| d01 | 3 | תודה! מה עוד יש במחיר דומה? | results | results | 0.75 | 0.75 | 4.0 | 100% |
| d03 | 3 | ספר לי על השלישי | detail | detail | n/a | n/a | 2.0 | 100% |
| d04 | 3 | רק מה שבמלאי | results | results | 1.00 | 1.00 | 4.0 | 100% |
| d02 | 3 | את המחשבים | miss | miss | n/a | n/a | 3.0 | 100% |
| d05 | 1 | מתנה לאבא | clarify | clarify | n/a | n/a | 4.0 | 100% |
| d01 | 4 | מה הכי זול אחרי הריל מי? | results | results | 1.00 | 1.00 | 5.0 | 100% |
| d06 | 1 | red headphones | results | results | 1.00 | 1.00 | 4.0 | 100% |
| d07 | 1 | שמלות | results | results | 1.00 | 1.00 | 4.0 | 100% |
| d05 | 2 | משהו עד 100 דולר | results | results | 0.75 | 0.75 | 4.0 | 100% |
| d06 | 2 | actually, show me sunglasses | results | results | 1.00 | 1.00 | 5.0 | 100% |
| d01 | 5 | אני רוצה פרטים על טלפון שיותר זול מ-Realme C35 | miss | miss | n/a | n/a | 4.0 | 100% |
| d07 | 2 | בצבע שחור | results | results | 1.00 | 1.00 | 5.0 | 100% |
| ad01 ✍ | 1 | טלפון סמסונג | results | results | 1.00 | 1.00 | 4.0 | 100% |
| d06 | 3 | only the ones in stock | results | results | 1.00 | 1.00 | 4.0 | 100% |
| ad02 ✍ | 1 | מחשבים ניידים | results | results | 1.00 | 1.00 | 5.0 | 100% |
| d07 | 3 | מתחת ל-100 | results | results | 1.00 | 1.00 | 5.0 | 100% |
| ad02 ✍ | 2 | תראה עוד | more | more | 1.00 | 1.25 | 4.0 | 100% |
| ad01 ✍ | 2 | יש משהו יותר זול? | miss | miss | n/a | n/a | 5.0 | 100% |
| ad02 ✍ | 3 | מה ההבדל בין הדל ללנובו? | compare | compare | n/a | n/a | 4.0 | 100% |
| ad03 ✍ | 1 | בושם ושעון לאישה עד 1000 | results | results | 1.00 | 0.86 | 4.0 | 100% |
| d07 | 4 | ומה עם נעליים? | results | results | 1.00 | 1.00 | 5.0 | 100% |
| ad01 ✍ | 3 | טוב אז רק מה שיש במלאי | results | results | 1.00 | 1.00 | 5.0 | 100% |
| ad04 ✍ | 1 | אני צריך מתנה לאשתי | clarify | clarify | n/a | n/a | 5.0 | 100% |
| ad02 ✍ | 4 | תודה. ומשהו עד 1200? | results | results | 1.00 | 1.00 | 5.0 | 100% |
| ad01 ✍ | 4 | ספר לי על הראשון | detail | detail | n/a | n/a | 2.0 | 100% |
| ad03 ✍ | 2 | תוזיל | ask_group | miss | n/a | n/a | 4.0 | 0% |
| ad02 ✍ | 5 | ספר לי עליו | detail | detail | n/a | n/a | 2.0 | 100% |
| ad03 ✍ | 3 | את השעונים | miss | dead_end | n/a | n/a | 2.0 | 0% |
| ad04 ✍ | 2 | היא אוהבת תכשיטים ובשמים, תקציב עד 100 דולר | results | results | 1.00 | 1.00 | 5.0 | 100% |
| ad01 ✍ | 5 | ומה עם אייפון במחיר דומה? | results | results | 0.50 | 1.00 | 4.0 | 0% |
| ad05 ✍ | 1 | נעלי ספורט לגבר | results | results | 1.00 | 1.00 | 5.0 | 100% |
| ad04 ✍ | 3 | ספר לי על הגוצ'י | detail | detail | n/a | n/a | 3.0 | 100% |
| ad03 ✍ | 4 | ומה עם תיק לאישה עד 100? | results | results | 1.00 | 1.00 | 5.0 | 100% |
| ad06 ✍ | 1 | ציוד לטניס | results | results | 1.00 | 1.00 | 5.0 | 100% |
| ad05 ✍ | 2 | עד 120 דולר | results | results | 1.00 | 0.75 | 5.0 | 100% |
| ad07 ✍ | 1 | שעון לגבר | results | results | 1.00 | 1.00 | 5.0 | 100% |
| ad04 ✍ | 4 | ומה עם משהו מתחת ל-30? | results | results | 1.00 | 1.00 | 3.0 | 100% |
| ad04 ✍ | 5 | תודה! זה מושלם | chat | chat | n/a | n/a | 3.0 | 100% |
| ad06 ✍ | 2 | ומה יש בגולף? | results | results | 1.00 | 1.00 | 5.0 | 100% |
| ad05 ✍ | 3 | יש בלבן? | results | results | 1.00 | 1.00 | 5.0 | 100% |
| ad07 ✍ | 2 | רק עד 2000 | results | results | 1.00 | 0.50 | 5.0 | 100% |
| ad08 ✍ | 1 | תיק לאישה | results | results | 1.00 | 1.00 | 5.0 | 100% |
| ad06 ✍ | 3 | ובכדורסל? | results | results | 0.67 | 1.00 | 5.0 | 0% |
| ad07 ✍ | 3 | מה ההבדל ביניהם? | compare | detail | n/a | n/a | 2.0 | 0% |
| ad05 ✍ | 4 | תוזיל קצת | miss | miss | n/a | n/a | 4.0 | 100% |
| ad08 ✍ | 2 | תביא פרטים על התיק השחור | detail | detail | n/a | n/a | 3.0 | 100% |
| ad06 ✍ | 4 | ספר לי על הטבעת | detail | miss | n/a | n/a | 1.0 | 0% |
| ad08 ✍ | 3 | תוכל להזמין לי מונית לחנות? | service | service | n/a | n/a | 4.0 | 100% |
| ad05 ✍ | 5 | אוקיי, תן לי פרטים על הזול | detail | detail | n/a | n/a | 4.0 | 100% |
| ad07 ✍ | 4 | תספר לי על הלונג'ין | detail | results | n/a | n/a | 4.0 | 0% |
| ad08 ✍ | 4 | טוב, תודה | chat | chat | n/a | n/a | 5.0 | 100% |
| u02 ✍ | 1 | אני רוצה לקנות מתנה לחברה שלי | clarify | clarify | n/a | n/a | 5.0 | 100% |
| u01 ✍ | 1 | אני רוצה אוזנוית | results | results | 1.00 | 0.67 | 5.0 | 100% |
| ad08 ✍ | 5 | ומה עם נעליים בזהב? | results | results | 1.00 | 1.00 | 5.0 | 100% |
| u01 ✍ | 2 | אוזניות ביטס | detail | detail | n/a | n/a | 4.0 | 100% |
| ad07 ✍ | 5 | תודה, ומה עם משהו לאישה? | results | results | 1.00 | 1.00 | 4.0 | 100% |
| u03 ✍ | 1 | אני רוצה לקנות מתנה ליום האהבה | clarify | clarify | n/a | n/a | 5.0 | 100% |
| u01 ✍ | 3 | אהה בעצם אוזניות אפל | results | detail | 0.00 | 0.00 | 4.0 | 0% |
| u02 ✍ | 2 | תכשיטים | results | results | 1.00 | 1.00 | 4.0 | 100% |
| u03 ✍ | 2 | עד 200 דולר | results | results | 1.00 | 1.00 | 3.0 | 100% |
| u02 ✍ | 3 | אהה בעצם משהו אחר עד 100 דולר | results | results | 1.00 | 1.00 | 3.0 | 100% |
| u03 ✍ | 3 | בלי הגבלת מחיר | results | results | 1.00 | 1.00 | 3.0 | 100% |
| u02 ✍ | 4 | לא תכשיטים משהו אחר | results | results | 1.00 | 1.00 | 3.0 | 100% |

## vague

| Case | Turn | Message | Expected | Got (per run) | P | R | Judge | Pass |
| --- | ---: | --- | --- | --- | ---: | ---: | ---: | ---: |
| v01 | 1 | מתנה לאבא | clarify | clarify | n/a | n/a | 4.0 | 100% |
| v03 | 1 | משהו לרכב שלי | clarify | clarify | n/a | n/a | 3.0 | 100% |
| v02 | 1 | something cheap and cool | results | results | n/a | n/a | 4.0 | 100% |
| av01 ✍ | 1 | מתנה לאמא ליום האם | clarify | clarify | n/a | n/a | 4.0 | 100% |
| av02 ✍ | 1 | משהו לחנוכת בית של חברה | results | results | n/a | n/a | 4.0 | 100% |
| av03 ✍ | 1 | משהו למשרד | clarify | clarify | n/a | n/a | 4.0 | 100% |
| av04 ✍ | 1 | משהו לים | results | results | n/a | n/a | 4.0 | 100% |
| av05 ✍ | 1 | תפתיע אותי | results | results | n/a | n/a | 5.0 | 100% |
| av07 ✍ | 1 | מתנה לחבר טוב | clarify | clarify | n/a | n/a | 4.0 | 100% |
| av08 ✍ | 1 | something nice for my girlfriend's birthday | clarify | clarify | n/a | n/a | 4.0 | 100% |
| av06 ✍ | 1 | מתנה לילד בן 10 עד 50 דולר | results | results | n/a | n/a | 3.0 | 100% |
| x14 ✍ | 1 | תמליץ לי על משהו טוב | results | results | n/a | n/a | 3.0 | 100% |

## Failures (first run of each)

- **c07#1** "כדור כדורסל": precision 0.50
  - reply: מצאתי את Basketball ב-$14.99 וגם את Basketball Rim ב-$39.99.
  - cards: Basketball $14.99 · Basketball Rim $39.99
- **c09#1** "רהיטים לסלון": precision 0.25; recall 0.25
  - reply: מצאתי 5 פריטי ריהוט, ובהם Knoll Saarinen Executive Conference Chair ב-$499.99 ו-Annibale Colombo Sofa ב-$2,499.99.
  - cards: Knoll Saarinen Executive Conference Chair $499.99 · Annibale Colombo Bed $1899.99 · Annibale Colombo Sofa $2499.99 · Wooden Bathroom Sink With Mirror $799.99
- **c12#1** "תיק יד שחור מעור": precision 0.67
  - reply: לא נמצאה התאמה לתיק יד שהוא גם שחור וגם מעור, אבל יש תיק עור לנשים, Heshe Women's Leather Bag, ב-$129.99, וגם תיק יד שחור.
  - cards: Heshe Women's Leather Bag $129.99 · White Faux Leather Backpack $39.99 · Women Handbag Black $59.99
- **c23#1** "מטען לאייפון": recall 0.33
  - reply: מצאתי את Apple iPhone Charger במחיר $19.99.
  - cards: Apple iPhone Charger $19.99
- **c25#1** "חולצה משובצת לגבר": recall 0.33
  - reply: מצאתי חולצה משובצת לגבר: Man Plaid Shirt במחיר $34.99.
  - cards: Man Plaid Shirt $34.99
- **a12#1** "נעלי עקב לגבר": action results (expected miss)
  - reply: לא נמצאו נעלי עקב לגבר, אבל יש נעלי גברים אחרות, כמו Puma Future Rider Trainers.
  - cards: Puma Future Rider Trainers $89.99 · Nike Air Jordan 1 Red And Black $149.99 · Sports Sneakers Off White & Red $119.99 · Sports Sneakers Off White Red $109.99
- **a14#1** "שמלה לילדה בת 6": precision 0.25
  - reply: לא מצאתי התאמה לגיל 6; יש כאן שמלות לילדות, כולל Girl Summer Dress ב־$19.99.
  - cards: Girl Summer Dress $19.99 · Tartan Dress $39.99 · Gray Dress $34.99 · Blue Frock $29.99
- **a17#1** "כדורגל": precision 0.50
  - reply: מצאתי 2 כדורים: American Football ב־$19.99 ו־Football ב־$17.99.
  - cards: American Football $19.99 · Football $17.99
- **a30#1** "שעון לגבר בשביל 300 שקל": action miss (expected results); precision 0.00; recall 0.00
  - reply: לא מצאתי בקטלוג "שעונים" עד $81. המחירים בדולרים; המרתי משקלים לפי כ-3.7 ₪ לדולר.
  - cards: none
- **a36#1** "אייפון ואוזניות עד 200 דולר": precision 0.50; 3 forbidden card(s)
  - reply: ל-iPhone נמצאו 4 תוצאות, אבל אף אחת מהתוצאות המוצגות אינה עד 200 דולר; באוזניות יש 2 אפשרויות עד 200 דולר, כולל Beats Flex Wireless Earphones ב-$49.99.
  - cards: iPhone 13 Pro $1099.99 · iPhone 6 $299.99 · iPhone 5s $199.99 · iPhone X $899.99 · Beats Flex Wireless Earphones $49.99 · Apple Airpods $129.99
- **a40#1** "נעליים אדומות": recall 0.25
  - reply: מצאתי נעליים אדומות: Red Shoes במחיר $34.99.
  - cards: Red Shoes $34.99
- **ad03#2** "תוזיל": action miss (expected ask_group)
  - reply: אין בשמים זולים מ-$49.99, ואין שעוני נשים זולים מ-$129.99. הכרטיסים הקודמים עדיין מוצגים: Calvin Klein CK One ב-$49.99 ו-Women's Wrist Watch ב-$129.99.
  - cards: Calvin Klein CK One $49.99 · Chanel Coco Noir Eau De $129.99 · Dolce Shine Eau de $69.99 · Dior J'adore $89.99 · Women's Wrist Watch $129.99 · Watch Gold for Women $799.99
- **ad03#3** "את השעונים": action dead_end (expected miss)
  - reply: על איזה מוצר מדובר? אפשר לציין מספר בין 1 ל-6 או את שם המוצר.
  - cards: none
- **ad01#5** "ומה עם אייפון במחיר דומה?": precision 0.50
  - reply: מצאתי כמה מכשירי iPhone; הראשון הוא iPhone 6 במחיר $299.99. גם iPhone 5s זמין ב־$199.99.
  - cards: iPhone 6 $299.99 · iPhone 5s $199.99 · iPhone X $899.99 · iPhone 13 Pro $1099.99
- **ad06#3** "ובכדורסל?": precision 0.67
  - reply: בכדורסל מצאתי שלושה פריטים, ובהם Basketball ב־$14.99 ו-Basketball Rim ב־$39.99.
  - cards: Basketball $14.99 · Basketball Rim $39.99 · Nike Air Jordan 1 Red And Black $149.99
- **ad07#3** "מה ההבדל ביניהם?": action detail (expected compare)
  - reply: אין כאן מידע על מוצר נוסף להשוואה. Brown Leather Belt Watch הוא שעון בעיצוב קלאסי, עם רצועת עור אמיתי וחוגה אלגנטית.
  - cards: none
- **ad06#4** "ספר לי על הטבעת": action miss (expected detail)
  - reply: לא מצאתי טבעות בקטלוג.
  - cards: none
- **ad07#4** "תספר לי על הלונג'ין": action results (expected detail)
  - reply: Longines Master Collection הוא שעון גברים, במחיר $1,499.99 ובדירוג 3.87.
  - cards: Longines Master Collection $1499.99
- **u01#3** "אהה בעצם אוזניות אפל": action detail (expected results); precision 0.00; recall 0.00
  - reply: Apple Airpods מבית Apple הן אוזניות אלחוטיות עם צימוד קל, צליל באיכות גבוהה ושילוב עם Siri. הן במלאי, עם אחריות ל־3 שנים ומשלוח בתוך 3–5 ימי עסקים.
  - cards: none

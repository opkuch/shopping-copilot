// Browser input → real routes → real orchestrator and retrieval over the recorded catalog → SQLite →
// rendered widgets → refresh. Models are scripted (server/test/fakes/scripted.ts), replies are templates.
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const composer = (page: Page) => page.getByRole("textbox", { name: "Message" });
const userBubbles = (page: Page, text: string) => page.locator(".message.user .bubble", { hasText: text });
const cards = (page: Page) => page.locator("article.product-card");
// The transcript only: reply text is also in the hidden live-region announcer.
const log = (page: Page) => page.getByRole("log", { name: "Conversation" });

async function send(page: Page, text: string) {
  await composer(page).fill(text);
  await composer(page).press("Enter");
}

async function prices(page: Page): Promise<number[]> {
  const texts = await cards(page).locator(".price").allTextContents();
  return texts.map((t) => Number(t.replace(/[$,]/g, "")));
}

async function newChat(page: Page, text: string): Promise<string> {
  await page.goto("/");
  await send(page, text);
  await page.waitForURL(/\/c\/[^/]+$/);
  return new URL(page.url()).pathname;
}

test("1. a new chat shows cards, survives a reload, and is listed", async ({ page }) => {
  const path = await newChat(page, "cheap sunglasses");
  await expect(cards(page)).toHaveCount(4);
  const before = await prices(page);
  expect(before).toEqual(before.toSorted((a, b) => a - b));

  await page.reload();
  await expect(cards(page)).toHaveCount(4);
  expect(await prices(page)).toEqual(before);
  expect(new URL(page.url()).pathname).toBe(path);
  await expect(page.getByRole("navigation", { name: "Conversations" }).locator(`a[href="${path}"]`)).toContainText("cheap sunglasses");
});

test("2. a multi-intent request shows two groups; the price bound applies only to fragrances", async ({ page }) => {
  await newChat(page, "a laptop and a fragrance under 50");
  const laptops = page.getByRole("region", { name: "Laptops" });
  const fragrances = page.getByRole("region", { name: "Fragrances" });
  await expect(laptops.locator("article.product-card").first()).toBeVisible();
  await expect(fragrances.locator("article.product-card").first()).toBeVisible();
  await expect(page.locator(".group-header h2")).toHaveText(["Laptops", "Fragrances"]);
  const fragrancePrices = (await fragrances.locator(".price").allTextContents()).map((t) => Number(t.replace(/[$,]/g, "")));
  expect(fragrancePrices.length).toBeGreaterThan(0);
  expect(fragrancePrices.every((p) => p <= 50)).toBe(true);
});

test("10. a follow-up reply taller than the screen is scrolled to its sentence, not its last card", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await newChat(page, "cheap sunglasses");
  await expect(cards(page)).toHaveCount(4);
  await send(page, "a laptop and a fragrance under 50");
  const reply = log(page).locator(".message.assistant").last();
  await expect(reply.locator("article.product-card").first()).toBeVisible();
  await expect(reply.locator(".assistant-text")).toBeInViewport();
});

test("11. only the transcript scrolls: the page itself never grows past the window", async ({ page }) => {
  // Regression: a visually hidden label (a card's rating) placed against the page instead of the
  // scrolling transcript stretched the page, and the page scrolled beside the transcript.
  for (const size of [{ width: 1440, height: 900 }, { width: 375, height: 812 }]) {
    await page.setViewportSize(size);
    await newChat(page, "a laptop and a fragrance under 50");
    await expect(cards(page).first()).toBeVisible();
    await send(page, "cheap sunglasses");
    await expect(log(page).locator(".message.assistant")).toHaveCount(2);
    await send(page, "tell me about the first one");
    await expect(log(page).locator("article.product-detail")).toBeVisible();
    const dims = await page.evaluate(() => ({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, vh: innerHeight, vw: innerWidth }));
    expect(dims.h, `page height at ${size.width}x${size.height}`).toBeLessThanOrEqual(dims.vh);
    expect(dims.w, `page width at ${size.width}x${size.height}`).toBeLessThanOrEqual(dims.vw);
  }
});

test("3. a follow-up in the same chat shows the detail for the first card", async ({ page }) => {
  await newChat(page, "cheap sunglasses");
  await expect(cards(page)).toHaveCount(4);
  const firstTitle = await cards(page).first().getByRole("heading").textContent();

  await send(page, "tell me about the first one");
  const detail = page.locator("article.product-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("heading")).toHaveText(firstTitle ?? "");
  await expect(detail.locator(".detail-description")).not.toBeEmpty();
});

test("4. a service request gets the service reply and no cards", async ({ page }) => {
  await newChat(page, "a flight to tokyo");
  await expect(log(page).getByText(/contact the store.s customer service/)).toBeVisible();
  await expect(cards(page)).toHaveCount(0);
});

test("5. switching conversations from the sidebar keeps each history, and sending continues the right one", async ({ page }) => {
  const first = await newChat(page, "cheap sunglasses");
  await expect(cards(page)).toHaveCount(4);

  await page.getByRole("link", { name: "New chat" }).click();
  await expect(page).toHaveURL(/\/$/);
  await send(page, "a flight to tokyo");
  await page.waitForURL(/\/c\/[^/]+$/);
  const second = new URL(page.url()).pathname;
  expect(second).not.toBe(first);

  const nav = page.getByRole("navigation", { name: "Conversations" });
  await nav.locator(`a[href="${first}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${first}$`));
  await expect(nav.locator(`a[href="${first}"]`)).toHaveAttribute("aria-current", "page");
  await expect(cards(page)).toHaveCount(4);
  await expect(log(page).getByText(/contact the store.s customer service/)).toHaveCount(0);

  await send(page, "tell me about the first one");
  await expect(page.locator("article.product-detail")).toBeVisible();
  await expect(page.getByText("This chat changed in another tab")).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${second}$`));
  await expect(log(page).getByText(/contact the store.s customer service/)).toBeVisible();
  await expect(page.locator("article.product-detail")).toHaveCount(0);
});

test("6. a failed reply shows Retry, and Retry answers without a second user message", async ({ page }) => {
  await newChat(page, "fail once");
  await expect(page.getByText("No reply yet.")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(cards(page).first()).toBeVisible();
  await expect(userBubbles(page, "fail once")).toHaveCount(1);
  await expect(page.getByText("No reply yet.")).toHaveCount(0);

  await page.reload();
  await expect(userBubbles(page, "fail once")).toHaveCount(1);
  await expect(cards(page).first()).toBeVisible();
});

test("7. a second tab on a stale revision gets the conflict, the winning transcript, and its text back", async ({ browser }) => {
  const one = await (await browser.newContext()).newPage();
  const path = await newChat(one, "cheap sunglasses");
  await expect(cards(one)).toHaveCount(4);

  const two = await (await browser.newContext()).newPage();
  await two.goto(path);
  await expect(cards(two)).toHaveCount(4);

  await send(one, "a flight to tokyo");
  await expect(log(one).getByText(/contact the store.s customer service/)).toBeVisible();

  await send(two, "tell me about the first one");
  await expect(two.getByText("This chat changed in another tab. Your message wasn't sent.")).toBeVisible();
  await expect(log(two).getByText(/contact the store.s customer service/)).toBeVisible();
  await expect(composer(two)).toHaveValue("tell me about the first one");
  await expect(two.locator("article.product-detail")).toHaveCount(0);
});

test("9. on a phone the list is a drawer: it opens with focus inside, closes on a choice and on Escape", async ({ page }) => {
  const path = await newChat(page, "cheap sunglasses");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");

  const menu = page.getByRole("button", { name: "Conversations" });
  const nav = page.getByRole("navigation", { name: "Conversations" });
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(nav.locator(`a[href="${path}"]`)).not.toBeInViewport();

  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: "New chat" })).toBeFocused();
  await nav.locator(`a[href="${path}"]`).click();
  await expect(page).toHaveURL(new RegExp(`${path}$`));
  await expect(cards(page)).toHaveCount(4);
  await expect(menu).toHaveAttribute("aria-expanded", "false");

  await menu.click();
  await expect(menu).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveAttribute("aria-expanded", "false");
  await expect(menu).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("8. reloading mid-turn resumes the same turn: one user message, one reply", async ({ page }) => {
  await newChat(page, "a flight to tokyo");
  await expect(log(page).getByText(/contact the store.s customer service/)).toBeVisible();

  // The scripted router holds "slow laptops" for 3 s. Reload while the server is still working on it.
  await send(page, "slow laptops");
  await expect(page.getByRole("status").filter({ hasText: "Understanding your request…" })).toBeVisible();
  await page.reload();

  // After the reload the client finds the unanswered message, sees the run in flight, and rejoins it.
  await expect(page.getByRole("status").filter({ hasText: /Understanding|Searching|Writing|Sending/ })).toBeVisible();
  await expect(cards(page).first()).toBeVisible();
  await expect(userBubbles(page, "slow laptops")).toHaveCount(1);
  await expect(page.locator(".message.assistant:not(.pending)")).toHaveCount(2);
  await expect(page.getByText("No reply yet.")).toHaveCount(0);
});

// axe on the states a shopper sees: the home page, results with chips and filters, a product detail; in English
// and in a Hebrew chat (Hebrew interface, right to left).
async function axe(page: Page, where: string) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(violations.map((v) => `${where}: ${v.id} (${v.nodes.length}) ${v.help}`)).toEqual([]);
}

test("12. accessibility: no axe violations in English and in a Hebrew chat", async ({ page }) => {
  // Fresh cards fade in; axe would measure their colors mid-fade. Reduced motion shows them settled.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await axe(page, "home");
  await newChat(page, "cheap sunglasses");
  await expect(cards(page).first()).toBeVisible();
  await axe(page, "results");
  await send(page, "tell me about the first one");
  await expect(log(page).locator("article.product-detail")).toBeVisible();
  await axe(page, "detail");

  await page.getByRole("link", { name: "New chat" }).click();
  // in a Hebrew chat the composer is labelled in Hebrew; the id stays the same
  const box = page.locator("#composer-input");
  await box.fill("משקפי שמש זולים");
  await box.press("Enter");
  await page.waitForURL(/\/c\/[^/]+$/);
  await expect(cards(page).first()).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.getByRole("button", { name: "שליחה" })).toBeVisible();
  await expect(page.locator(".group-header h2").first()).toHaveText("משקפי שמש");
  await axe(page, "hebrew results");
  await expect(page.getByRole("textbox", { name: "הודעה" })).toBeVisible();
  await box.fill("ספר לי על הראשון");
  await box.press("Enter");
  await expect(page.getByRole("log", { name: "שיחה" }).locator("article.product-detail")).toBeVisible();
  await axe(page, "hebrew detail");
});

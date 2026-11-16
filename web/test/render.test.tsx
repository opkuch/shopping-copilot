import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { AssistantMessage as Assistant, ConversationView } from "../src/api/types.ts";
import { Transcript } from "../src/components/Conversation.tsx";
import { Home, STARTER_PROMPTS } from "../src/components/Home.tsx";
import { AssistantMessage } from "../src/components/Messages.tsx";
import { STRINGS } from "../src/i18n.ts";
import { assistant, card, conversation, detail, group, missGroup, unavailableGroup, user } from "./fixtures/messages.ts";

afterEach(cleanup);

const noTurn = { inflight: null, notSent: null, tail: null, canRetry: true, onRetry: () => {}, onSuggest: () => {} };
const renderView = (view: ConversationView) =>
  render(<Transcript messages={view.messages} conversationId={view.id} revision={view.revision} {...noTurn} />);

const renderMessage = (m: Assistant) => render(<AssistantMessage message={m} />);
const cards = () => screen.queryAllByRole("article");

describe("product cards", () => {
  test("a card shows title, description, dollar price with cents, image with alt, and rating", () => {
    renderMessage(assistant({ groups: [group({ products: [card({ price: 9.9, rating: 4.52 })], total: 1 })] }));
    const article = screen.getByRole("article");
    const c = within(article);
    expect(c.getByRole("heading", { name: "Black Sun Glasses" })).toBeTruthy();
    expect(c.getByText("Classic black sunglasses with UV protection.")).toBeTruthy();
    expect(c.getByText("$9.90")).toBeTruthy();
    expect(c.getByRole("img", { name: "Black Sun Glasses" }).getAttribute("src")).toContain("cdn.dummyjson.com");
    expect(c.getByText("Rated 4.5 out of 5")).toBeTruthy();
    expect(c.queryByText("Out of stock")).toBeNull();
  });

  test("an out-of-stock card says so in text", () => {
    renderMessage(assistant({ groups: [group({ products: [card({ inStock: false })], total: 1 })] }));
    expect(screen.getByText("Out of stock")).toBeTruthy();
  });

  test("a failed image swaps to the inline placeholder without another request", () => {
    renderMessage(assistant({ groups: [group({ products: [card()], total: 1 })] }));
    const img = screen.getByRole("img", { name: "Black Sun Glasses" });
    fireEvent.error(img);
    expect(screen.queryByRole("img", { name: "Black Sun Glasses" })).toBeNull();
    const article = screen.getByRole("article");
    expect(article.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(within(article).getByRole("heading", { name: "Black Sun Glasses" })).toBeTruthy();
  });
});

describe("group states", () => {
  test.each([
    [4, 23, "4 of 23"],
    [4, 4, "4 results"],
    [1, 1, "1 result"],
  ])("countOf(%i, %i) is %s", (shown, total, label) => {
    expect(STRINGS.en.countOf(shown, total)).toBe(label);
  });

  test("results render a header with the count and the cards", () => {
    renderMessage(assistant());
    const section = screen.getByRole("region", { name: "Sunglasses" });
    expect(within(section).getByText("4 of 23")).toBeTruthy();
    expect(within(section).getAllByRole("article")).toHaveLength(4);
  });

  test("a miss shows no cards; unavailable shows a load failure; the texts differ", () => {
    renderMessage(assistant({ groups: [missGroup("Laptops"), unavailableGroup("Fragrances")] }));
    const miss = screen.getByRole("region", { name: "Laptops" });
    const down = screen.getByRole("region", { name: "Fragrances" });
    expect(within(miss).getByText("No matching products.")).toBeTruthy();
    expect(within(down).getByText("Couldn't load these results right now.")).toBeTruthy();
    expect(within(miss).queryByText(/couldn't load/i)).toBeNull();
    expect(cards()).toHaveLength(0);
  });

  test("two groups render two headers in order", () => {
    renderMessage(assistant({ groups: [group({ label: "Laptops" }), group({ label: "Fragrances" })] }));
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Laptops", "Fragrances"]);
  });
});

describe("detail", () => {
  test("renders the full description and only the non-null facts", () => {
    renderMessage(assistant({ text: "Here are more details about Black Sun Glasses.", groups: [], detail: detail() }));
    expect(screen.getByText(/The full description is longer/)).toBeTruthy();
    expect(screen.getByText("Ray-Ban")).toBeTruthy();
    expect(screen.getByText("Ships in 1 week")).toBeTruthy();
    expect(screen.queryByText("Warranty")).toBeNull();
    expect(screen.queryByText("Returns")).toBeNull();
    expect(screen.getByText("(3 reviews)")).toBeTruthy();
    expect(screen.queryByText(/Live details are unavailable/)).toBeNull();
  });

  test("a stored-card detail says live details are unavailable", () => {
    renderMessage(assistant({ groups: [], detail: detail({ source: "stored_card", brand: null, reviewCount: null }) }));
    expect(screen.getByText("Live details are unavailable right now; showing what we had.")).toBeTruthy();
    expect(screen.queryByText(/reviews?\)/)).toBeNull();
  });
});

describe("message text and safety", () => {
  test("an unreadable message says so and renders no widgets", () => {
    renderMessage(assistant({ unreadable: true, groups: [] }));
    expect(screen.getByText("Couldn't load these results.")).toBeTruthy();
    expect(cards()).toHaveLength(0);
  });

  test("markup in text is shown literally, never parsed", () => {
    const { container } = renderMessage(assistant({ text: "<b>x</b><img src=x onerror=alert(1)>", groups: [] }));
    expect(screen.getByText("<b>x</b><img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  test("message text and titles carry dir=auto for right-to-left input", () => {
    renderView(conversation({ messages: [user({ text: "משקפי שמש זולים" }), assistant()] }));
    expect(screen.getByText("משקפי שמש זולים").getAttribute("dir")).toBe("auto");
    expect(screen.getByText(/Here are 4 of 23/).getAttribute("dir")).toBe("auto");
  });
});

describe("transcript", () => {
  test("renders messages in order inside a log", () => {
    renderView(conversation());
    const log = screen.getByRole("log", { name: "Conversation" });
    expect(within(log).getByText("cheap sunglasses")).toBeTruthy();
    expect(within(log).getAllByRole("article")).toHaveLength(4);
  });

  test("a message that throws while rendering is replaced, and its siblings still render", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = assistant({ id: "a2", groups: null as unknown as Assistant["groups"] });
    renderView(conversation({ messages: [user(), assistant(), user({ id: "u2", text: "and laptops" }), broken] }));
    expect(screen.getByText("Couldn't display this message.")).toBeTruthy();
    expect(screen.getByText("and laptops")).toBeTruthy();
    expect(screen.getAllByRole("article")).toHaveLength(4);
    expect(spy).toHaveBeenCalled();
  });
});

describe("working search", () => {
  // Two searches: the older one (sunglasses) is superseded by the laptops, then a detail reply with no cards.
  const older = assistant({ id: "a1" });
  const laptops = group({
    label: "Laptops",
    products: [card({ id: 11, title: "Dell XPS" }), card({ id: 12, title: "Lenovo Yoga" })],
    total: 2,
  });
  const latest = assistant({ id: "a2", groups: [laptops, group({ label: "Fragrances", products: [card({ id: 21, title: "CK One" })], total: 1 })] });
  const detailReply = assistant({ id: "a3", groups: [], detail: detail() });
  const messages = [user(), older, user({ id: "u2", text: "laptops and a perfume" }), latest, user({ id: "u3", text: "tell me about it" }), detailReply];

  test("only the cards of the latest search are numbered, across both groups", () => {
    render(<Transcript messages={messages} conversationId="c1" revision={3} {...noTurn} />);
    const numbered = document.querySelectorAll(".product-number");
    expect([...numbered].map((n) => n.textContent)).toEqual(["1", "2", "3"]);
    const ck = screen.getByRole("heading", { name: "CK One" }).closest("article") as HTMLElement;
    expect(within(ck).getByText("3")).toBeTruthy();
  });

  test("clicking a card of the latest search asks about it; older cards are not buttons; nothing opens while a reply is pending", () => {
    const onSuggest = vi.fn();
    const { rerender } = render(<Transcript messages={messages} conversationId="c1" revision={3} {...noTurn} onSuggest={onSuggest} />);
    fireEvent.click(screen.getByRole("button", { name: "Lenovo Yoga" }));
    expect(onSuggest).toHaveBeenCalledWith("tell me about the Lenovo Yoga");
    expect(screen.queryByRole("button", { name: "Party Glasses" })).toBeNull();
    rerender(<Transcript messages={messages} conversationId="c1" revision={3} {...noTurn} canRetry={false} onSuggest={onSuggest} />);
    expect(screen.queryByRole("button", { name: "Lenovo Yoga" })).toBeNull();
  });
});

describe("home", () => {
  test("a starter prompt sends its text; starters are disabled while a send is in flight", () => {
    const onSend = vi.fn();
    const { rerender } = render(<Home canSend onSend={onSend} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(STARTER_PROMPTS);
    fireEvent.click(buttons[0] as HTMLElement);
    expect(onSend).toHaveBeenCalledWith(STARTER_PROMPTS[0]);
    rerender(<Home canSend={false} onSend={onSend} />);
    expect(screen.getAllByRole("button").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe("pending and failed turns", () => {
  const view = conversation({ messages: [user(), assistant(), user({ id: "u2", text: "and laptops" })] });
  const props = { messages: view.messages, conversationId: view.id, revision: 3 };

  test("a send in flight that is not in the transcript yet shows its bubble and the stage label", () => {
    const inflight = { messageId: "m9", text: "something new", conversationId: "c1", revision: 3, stage: "searching" as const };
    render(<Transcript {...props} {...noTurn} inflight={inflight} />);
    expect(screen.getByText("something new")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Searching the catalog…");
  });

  test("a resumed send for the tail shows the label under the existing bubble, not a second bubble", () => {
    const inflight = { messageId: "u2", text: "and laptops", conversationId: "c1", revision: 3, stage: "classifying" as const };
    render(<Transcript {...props} {...noTurn} inflight={inflight} />);
    expect(screen.getAllByText("and laptops")).toHaveLength(1);
    expect(screen.getByRole("status").textContent).toBe("Understanding your request…");
  });

  test("a stalled tail shows No reply yet with a Retry that resends the same message", () => {
    const onRetry = vi.fn();
    render(<Transcript {...props} {...noTurn} tail={{ messageId: "u2", status: "stalled" }} onRetry={onRetry} />);
    expect(screen.getByText("No reply yet.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith({ messageId: "u2", text: "and laptops", conversationId: "c1", revision: 3 });
  });

  test("a tail still being checked shows nothing extra", () => {
    render(<Transcript {...props} {...noTurn} tail={{ messageId: "u2", status: "checking" }} />);
    expect(screen.queryByText("No reply yet.")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  test("a network failure shows Not sent with Retry; Retry is disabled while another send is in flight", () => {
    const notSent = { messageId: "m9", text: "lost words", conversationId: "c1", revision: 3 };
    const onRetry = vi.fn();
    const { rerender } = render(<Transcript {...props} {...noTurn} notSent={notSent} onRetry={onRetry} />);
    expect(screen.getByText("Not sent.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledWith(notSent);
    rerender(<Transcript {...props} {...noTurn} notSent={notSent} canRetry={false} onRetry={onRetry} />);
    expect((screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("suggestion chips", () => {
  const chips = [{ label: "Up to $50", text: "up to $50" }, { label: "For him", text: "for him" }];
  const view = (more: ConversationView["messages"] = []) => conversation({
    messages: [user({ id: "u1", text: "a gift" }), assistant({ id: "a1", groups: [], suggestions: chips }), ...more],
  });

  test("the latest reply's chips send their text as the next message", () => {
    const onSuggest = vi.fn();
    const v = view();
    render(<Transcript messages={v.messages} conversationId={v.id} revision={v.revision} {...noTurn} onSuggest={onSuggest} />);
    fireEvent.click(screen.getByRole("button", { name: "Up to $50" }));
    expect(onSuggest).toHaveBeenCalledWith("up to $50");
  });

  test("chips under an older reply are not shown: they would answer a stale question", () => {
    const v = view([user({ id: "u2", text: "for him" }), assistant({ id: "a2" })]);
    render(<Transcript messages={v.messages} conversationId={v.id} revision={v.revision} {...noTurn} />);
    expect(screen.queryByRole("button", { name: "Up to $50" })).toBeNull();
  });

  test("no chips while a send is in flight", () => {
    const v = view();
    render(<Transcript messages={v.messages} conversationId={v.id} revision={v.revision} {...noTurn} canRetry={false} />);
    expect(screen.queryByRole("button", { name: "Up to $50" })).toBeNull();
  });
});

describe("cards first", () => {
  test("while the reply is written, the cards are already shown under the muted template sentence", () => {
    const inflight = { messageId: "m9", text: "sunglasses", conversationId: "c1", revision: 3, stage: "writing" as const,
      preview: { groups: [group()], text: "Here are 4 of 23 sunglasses, lowest price first." } };
    render(<Transcript messages={[]} conversationId="c1" revision={3} {...noTurn} inflight={inflight} />);
    expect(screen.getByText("Here are 4 of 23 sunglasses, lowest price first.").className).toContain("draft");
    expect(screen.getAllByRole("article").length).toBeGreaterThan(0);
    expect(screen.getByRole("status").textContent).toBe("Writing a reply…");
  });
});

describe("cards are drawn once", () => {
  test("a group carried forward unchanged is one line, not the same cards again", () => {
    renderMessage(assistant({ groups: [group({ repeat: true })], text: "Nothing in this search is cheaper than $22.99." }));
    expect(screen.queryAllByRole("article")).toHaveLength(0);
    expect(screen.getByText(/the products above are still the matches/)).toBeTruthy();
  });

  test("show more draws only the cards it added", () => {
    const products = [card({ id: 1, title: "A" }), card({ id: 2, title: "B" }), card({ id: 3, title: "C" }), card({ id: 4, title: "D" }), card({ id: 5, title: "E" })];
    renderMessage(assistant({ groups: [group({ products, total: 5, shownFrom: 4 })] }));
    expect(screen.getAllByRole("article")).toHaveLength(1);
    expect(screen.getByText("E")).toBeTruthy();
    expect(screen.getByText("5–5 of 5")).toBeTruthy();
  });
});

test("a kept group that had no cards draws nothing (there is nothing 'above' to point at)", () => {
  renderMessage(assistant({ groups: [group({ repeat: true, status: "miss", products: [], total: 0 })], text: "Nothing cheaper." }));
  expect(screen.queryByText(/still the matches/)).toBeNull();
});

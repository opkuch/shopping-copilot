import { afterEach, expect, test } from "vitest";
import { currentRoute, navigate, onPopState, parsePath, pathFor } from "../src/state/router.ts";

afterEach(() => window.history.replaceState(null, "", "/"));

test.each([
  ["/", { view: "home" }, null],
  ["/c/abc", { view: "conversation", id: "abc" }, null],
  ["/c/abc/", { view: "conversation", id: "abc" }, "/c/abc"],
  ["/c/a%20b", { view: "conversation", id: "a b" }, null],
  ["/c/", { view: "home" }, "/"],
  ["/c/%20", { view: "home" }, "/"],
  ["/c/%E0%A4%A", { view: "home" }, "/"],
  ["/c/a/b", { view: "home" }, "/"],
  ["/conversations", { view: "home" }, "/"],
  ["/index.html", { view: "home" }, "/"],
])("parsePath(%s)", (path, route, canonical) => {
  expect(parsePath(path)).toEqual({ route, canonical });
});

test("pathFor round-trips through parsePath", () => {
  for (const id of ["abc", "a b", "x/y", "ü"]) {
    const route = { view: "conversation", id } as const;
    expect(parsePath(pathFor(route)).route).toEqual(route);
  }
});

test("currentRoute rewrites a non-canonical address without adding history", () => {
  window.history.replaceState(null, "", "/nowhere");
  const before = window.history.length;
  expect(currentRoute()).toEqual({ view: "home" });
  expect(window.location.pathname).toBe("/");
  expect(window.history.length).toBe(before);
});

test("navigate pushes, replaces, and does not push the same path twice", () => {
  const start = window.history.length;
  navigate({ view: "conversation", id: "a" });
  expect(window.location.pathname).toBe("/c/a");
  expect(window.history.length).toBe(start + 1);
  navigate({ view: "conversation", id: "a" });
  expect(window.history.length).toBe(start + 1);
  navigate({ view: "conversation", id: "b" }, { replace: true });
  expect(window.location.pathname).toBe("/c/b");
  expect(window.history.length).toBe(start + 1);
});

test("onPopState reports the route and unsubscribes", () => {
  const seen: unknown[] = [];
  const stop = onPopState((r) => seen.push(r));
  window.history.replaceState(null, "", "/c/z");
  window.dispatchEvent(new PopStateEvent("popstate"));
  stop();
  window.dispatchEvent(new PopStateEvent("popstate"));
  expect(seen).toEqual([{ view: "conversation", id: "z" }]);
});

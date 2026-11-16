// Two routes do not need a router library: `/` and `/c/:id`.
export type Route = { view: "home" } | { view: "conversation"; id: string };

export type Parsed = {
  route: Route;
  /** Set when the address bar should be rewritten (unknown path, trailing slash). */
  canonical: string | null;
};

export function pathFor(route: Route): string {
  return route.view === "home" ? "/" : `/c/${encodeURIComponent(route.id)}`;
}

export function parsePath(pathname: string): Parsed {
  if (pathname === "/") return { route: { view: "home" }, canonical: null };
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  if (match) {
    let id: string;
    try {
      id = decodeURIComponent(match[1] as string);
    } catch {
      return { route: { view: "home" }, canonical: "/" };
    }
    if (id.trim() === "") return { route: { view: "home" }, canonical: "/" };
    const route: Route = { view: "conversation", id };
    const path = pathFor(route);
    return { route, canonical: path === pathname ? null : path };
  }
  return { route: { view: "home" }, canonical: "/" };
}

/** Reads the current location, fixing the address bar when it is not canonical. */
export function currentRoute(): Route {
  const { route, canonical } = parsePath(window.location.pathname);
  if (canonical !== null) window.history.replaceState(null, "", canonical);
  return route;
}

export function navigate(route: Route, opts: { replace?: boolean } = {}): void {
  const path = pathFor(route);
  if (opts.replace) window.history.replaceState(null, "", path);
  else if (window.location.pathname !== path) window.history.pushState(null, "", path);
}

export function onPopState(listener: (route: Route) => void): () => void {
  const handler = () => listener(currentRoute());
  window.addEventListener("popstate", handler);
  return () => window.removeEventListener("popstate", handler);
}

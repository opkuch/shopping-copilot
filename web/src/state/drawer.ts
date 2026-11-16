// The conversation list becomes a drawer below 900 px. UI-only state, so it
// lives here and not in the app reducer.
import { useCallback, useEffect, useRef, useState } from "react";

export const NARROW_QUERY = "(max-width: 899px)";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * Open/close with focus management: opening focuses the first link in the drawer, closing returns
 * focus to the menu button, Escape closes. Widening the window past the breakpoint closes it.
 */
export function useDrawer(narrow: boolean) {
  const [open, setOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Widening closes the drawer for good, so narrowing again does not reopen it by itself.
  // Adjusted during render (React's "storing information from previous renders"), not in an effect.
  const [wasNarrow, setWasNarrow] = useState(narrow);
  if (wasNarrow !== narrow) {
    setWasNarrow(narrow);
    if (!narrow) setOpen(false);
  }
  const isOpen = open && narrow;

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => setOpen((o) => !o), []);

  const wasOpen = useRef(false);
  useEffect(() => {
    if (isOpen) drawerRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    // On a wide window the menu button is hidden; focusing it would lose focus.
    else if (wasOpen.current && narrow) buttonRef.current?.focus();
    wasOpen.current = isOpen;
  }, [isOpen, narrow]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

  return { isOpen, close, toggle, drawerRef, buttonRef };
}

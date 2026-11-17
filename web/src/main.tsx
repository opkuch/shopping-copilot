import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
// Self-hosted (OFL): the page's CSP allows fonts from this origin only.
import "@fontsource-variable/schibsted-grotesk";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    {/* A render error outside a single message: a line to reload, not a blank page. */}
    <ErrorBoundary fallback={<p className="app-failed" role="alert">Something went wrong. Reload the page to continue.</p>}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

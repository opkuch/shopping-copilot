import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

type Props = { children: ReactNode; fallback: ReactNode };
type State = { failed: boolean };

// The client does not re-validate server payloads (the server already marks bad ones `unreadable`).
// This is the client's own safety net: a message that still throws while rendering is replaced by
// `fallback`, and the rest of the chat keeps working. Keyed by message id by the caller.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("A message failed to render:", error, info.componentStack);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

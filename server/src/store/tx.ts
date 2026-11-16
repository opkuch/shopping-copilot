import type { DatabaseSync } from "node:sqlite";

// Invariant: never await between BEGIN and COMMIT. DatabaseSync is synchronous, so a
// transaction with no await finishes before the event loop serves another request; an
// await would let a second request's statements join this open transaction.
// The intersection makes a Promise-returning callback a compile error.
export function withTransaction<T>(
  db: DatabaseSync,
  fn: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original error is the one worth reporting.
    }
    throw err;
  }
}

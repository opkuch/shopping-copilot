// Typechecked only (tsc includes test/). Fails `npm run typecheck` if the async guard regresses.
import { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../../src/store/tx.ts";

export function check(db: DatabaseSync): number {
  // @ts-expect-error callbacks must be synchronous
  withTransaction(db, async () => 1);
  return withTransaction(db, () => 1);
}

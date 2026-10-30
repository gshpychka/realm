// The shared history API. Cursors identify immutable database rows.
import * as Schema from "effect/Schema";
import { Run } from "./schema";

export const HISTORY_ROUTES = {
  results: "/results.json",
  checkpoints: "/api/history/checkpoints",
} as const;

export const HistoryPage = Schema.Struct({
  runs: Schema.Array(Run),
  cursor: Schema.Int.pipe(Schema.nonNegative()),
  next: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
});

export const CheckpointRequest = Schema.Struct({
  runs: Schema.Array(Run).pipe(Schema.minItems(1), Schema.maxItems(32)),
});

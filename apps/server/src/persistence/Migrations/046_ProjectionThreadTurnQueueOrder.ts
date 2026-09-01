import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_thread_turn_queue ADD COLUMN queue_order INTEGER NOT NULL DEFAULT 0
  `;
  yield* sql`
    UPDATE projection_thread_turn_queue
    SET queue_order = event_sequence
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_projection_thread_turn_queue_thread_order
    ON projection_thread_turn_queue(thread_id, queue_order)
  `;
});

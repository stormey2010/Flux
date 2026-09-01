import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("046_ProjectionThreadTurnQueueOrder", (it) => {
  it.effect("adds stable queue ordering while retaining event provenance", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_thread_turn_queue)
      `;
      const queueOrder = columns.find((column) => column.name === "queue_order");
      assert.equal(queueOrder?.notnull, 1);
      const indexes = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_thread_turn_queue)
      `;
      assert.equal(
        indexes.some((index) => index.name === "idx_projection_thread_turn_queue_thread_order"),
        true,
      );
    }),
  );
});

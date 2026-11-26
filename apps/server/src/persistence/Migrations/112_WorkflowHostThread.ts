import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE workflow_runs ADD COLUMN host_thread_id TEXT`;
  yield* sql`ALTER TABLE workflow_runs ADD COLUMN manual_pause_stage TEXT`;
  yield* sql`
    CREATE INDEX workflow_runs_host_thread ON workflow_runs (host_thread_id, started_at DESC)
    WHERE host_thread_id IS NOT NULL
  `;
});

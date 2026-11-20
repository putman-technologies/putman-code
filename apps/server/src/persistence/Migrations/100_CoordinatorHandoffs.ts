import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE coordinator_handoffs (
    message_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, snapshot_json TEXT,
    additional_pulls_json TEXT, assets_json TEXT, assets_revision TEXT, approved_revision TEXT, prepared_revision TEXT
  )`;
});

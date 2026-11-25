import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE coordinator_handoffs ADD COLUMN external_thread TEXT`;
  yield* sql`ALTER TABLE coordinator_handoffs ADD COLUMN received_at TEXT`;
  yield* sql`ALTER TABLE coordinator_handoffs ADD COLUMN repair_base TEXT`;
  yield* sql`ALTER TABLE coordinator_handoffs ADD COLUMN continuation_of TEXT`;
  yield* sql`ALTER TABLE coordinator_handoffs ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE coordinator_handoffs ADD COLUMN released_revision TEXT`;
  yield* sql`CREATE INDEX coordinator_queue_project ON coordinator_handoffs(project_id,external_thread)`;
  yield* sql`CREATE TABLE coordinator_release_requests (request_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision TEXT NOT NULL, state TEXT NOT NULL)`;
  yield* sql`CREATE TABLE coordinator_playbooks (project_id TEXT PRIMARY KEY, instructions TEXT NOT NULL, auto_repair INTEGER NOT NULL DEFAULT 0, github_release INTEGER NOT NULL DEFAULT 0)`;
});

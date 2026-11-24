import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN second_brain_enabled INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE TABLE second_brain_entries (
    project_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    recorded_at TEXT NOT NULL, body TEXT NOT NULL, files_json TEXT NOT NULL,
    checkpoint_ref TEXT, parent_ref TEXT, cwd TEXT,
    next_attempt INTEGER, PRIMARY KEY(project_id, kind, source_id)
  )`;
  yield* sql`CREATE INDEX second_brain_project_date ON second_brain_entries(project_id, recorded_at DESC)`;
  yield* sql`CREATE INDEX second_brain_pending ON second_brain_entries(next_attempt) WHERE next_attempt IS NOT NULL`;
  yield* sql`CREATE TABLE second_brain_copies (
    project_id TEXT NOT NULL, kind TEXT NOT NULL, source_id TEXT NOT NULL,
    name TEXT NOT NULL, file_key TEXT NOT NULL,
    PRIMARY KEY(project_id, kind, source_id, file_key)
  )`;
  yield* sql`CREATE INDEX second_brain_copy_names ON second_brain_copies(project_id, name, kind)`;

  yield* sql`CREATE VIEW second_brain_message_sources AS
    SELECT t.project_id, m.role AS kind, m.message_id AS source_id, m.thread_id, m.created_at AS recorded_at,
      json_extract(m.payload_json,'$.text') AS body, coalesce(json_extract(m.payload_json,'$.attachments'),'[]') AS files_json
    FROM orchestration_v2_projection_messages m JOIN orchestration_v2_projection_threads t USING(thread_id)
    JOIN projection_projects p ON p.project_id=t.project_id
    WHERE p.second_brain_enabled=1 AND p.deleted_at IS NULL AND t.deleted_at IS NULL AND m.streaming=0
      AND (m.role='assistant' OR (m.role='user' AND coalesce(json_extract(m.payload_json,'$.createdBy'),'user')='user'))
  `;
  yield* sql`CREATE VIEW second_brain_checkpoint_sources AS
    SELECT t.project_id, 'checkpoint' AS kind, c.checkpoint_id AS source_id, c.thread_id,
      c.captured_at AS recorded_at, 'Changed files' AS body,
      json_extract(c.payload_json,'$.files') AS files_json, json_extract(c.payload_json,'$.ref') AS checkpoint_ref,
      json_extract(b.payload_json,'$.ref') AS parent_ref, coalesce(json_extract(s.payload_json,'$.cwd'),p.workspace_root) AS cwd
    FROM orchestration_v2_projection_checkpoints c JOIN orchestration_v2_projection_threads t USING(thread_id)
    JOIN projection_projects p ON p.project_id=t.project_id
    LEFT JOIN orchestration_v2_projection_checkpoint_scopes s ON s.scope_id=c.scope_id AND s.thread_id=t.thread_id
    LEFT JOIN orchestration_v2_projection_checkpoints b ON b.checkpoint_id=coalesce(json_extract(c.payload_json,'$.parentCheckpointId'),c.parent_checkpoint_id)
      AND b.scope_id=c.scope_id AND b.thread_id=c.thread_id
    WHERE p.second_brain_enabled=1 AND p.deleted_at IS NULL AND t.deleted_at IS NULL AND c.status='ready'
      AND json_array_length(c.payload_json,'$.files') > 0
  `;
  for (const source of [
    {
      table: "orchestration_v2_projection_messages",
      view: "second_brain_message_sources",
      id: "message_id",
      when: "NEW.streaming=0 AND NEW.role IN ('user','assistant')",
      extra: "",
    },
    {
      table: "orchestration_v2_projection_checkpoints",
      view: "second_brain_checkpoint_sources",
      id: "checkpoint_id",
      when: "NEW.status='ready'",
      extra: ", checkpoint_ref, parent_ref, cwd",
    },
  ]) {
    const columns =
      "project_id,kind,source_id,thread_id,recorded_at,body,files_json" + source.extra;
    const capture = (
      predicate: string,
    ) => `INSERT INTO second_brain_entries (${columns},next_attempt)
      SELECT ${columns}, CASE WHEN json_array_length(files_json)>0 THEN 0 END FROM ${source.view} WHERE ${predicate}
      ON CONFLICT(project_id,kind,source_id) DO UPDATE SET body=excluded.body, files_json=excluded.files_json,
        next_attempt=CASE WHEN files_json<>excluded.files_json THEN excluded.next_attempt ELSE next_attempt END;`;
    for (const event of ["INSERT", "UPDATE"]) {
      yield* sql.unsafe(`CREATE TRIGGER brain_${source.id}_${event} AFTER ${event} ON ${source.table}
        WHEN ${source.when} BEGIN ${capture(`source_id=NEW.${source.id}`)} END`);
    }
    yield* sql.unsafe(`CREATE TRIGGER brain_enroll_${source.id} AFTER UPDATE OF second_brain_enabled ON projection_projects
      WHEN OLD.second_brain_enabled=0 AND NEW.second_brain_enabled=1 AND NEW.deleted_at IS NULL
      BEGIN ${capture("project_id=NEW.project_id")} END`);
  }
});

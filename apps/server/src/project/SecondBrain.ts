import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import { brainFilePath, captureBrainFiles, type BrainEntry } from "./secondBrainFiles.ts";

class BrainFileError extends Schema.TaggedError<BrainFileError>()("BrainFileError", {
  cause: Schema.Defect(),
}) {}

const encodeIds = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const captureEntry = Effect.fn("SecondBrain.captureEntry")(function* (
  entry: BrainEntry,
  attachmentIds?: ReadonlySet<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const known =
    entry.kind === "checkpoint"
      ? yield* sql<{
          name: string;
        }>`SELECT DISTINCT name FROM second_brain_copies WHERE project_id=${entry.project_id} AND kind='checkpoint'`
      : [];
  const result = yield* Effect.tryPromise({
    try: (signal) =>
      captureBrainFiles(
        entry,
        config,
        new Set(known.map((row) => row.name)),
        signal,
        attachmentIds,
      ),
    catch: (cause) => new BrainFileError({ cause }),
  });
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const copy of result.copies) {
        yield* sql`INSERT OR IGNORE INTO second_brain_copies(project_id,kind,source_id,name,file_key)
        VALUES(${entry.project_id},${entry.kind},${entry.source_id},${copy.name},${copy.fileKey})`;
      }
      if (!attachmentIds && !result.pending) {
        yield* sql`UPDATE second_brain_entries SET next_attempt=NULL WHERE project_id=${entry.project_id} AND kind=${entry.kind} AND source_id=${entry.source_id} AND files_json=${entry.files_json}`;
      }
    }),
  );
  if (result.pending) return yield* new BrainFileError({ cause: "Source file copy incomplete" });
});

export const capturePending = Effect.fn("SecondBrain.capturePending")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<BrainEntry>`SELECT e.* FROM second_brain_entries e
    JOIN projection_projects p USING(project_id) WHERE e.next_attempt <= unixepoch()
    AND p.second_brain_enabled=1 AND p.deleted_at IS NULL
    ORDER BY e.next_attempt,e.recorded_at LIMIT 24`;
  for (const entry of rows) {
    yield* captureEntry(entry).pipe(
      Effect.catchTags({
        BrainFileError: () =>
          sql`UPDATE second_brain_entries SET next_attempt=unixepoch()+60 WHERE project_id=${entry.project_id} AND kind=${entry.kind} AND source_id=${entry.source_id} AND next_attempt IS NOT NULL`,
      }),
    );
  }
  return rows.length;
});

// A user may delete a thread or roll back a turn before the background worker runs.
export class PreserveSources extends Context.Reference<{
  beforeRemoval: (
    kind: "attachment" | "checkpoint",
    ids: readonly string[],
  ) => Effect.Effect<void, BrainFileError>;
}>("putman/SecondBrain/PreserveSources", {
  defaultValue: () => ({ beforeRemoval: () => Effect.void }),
}) {}

export const preservation = Layer.effect(
  PreserveSources,
  Effect.gen(function* () {
    const services = yield* Effect.context<SqlClient.SqlClient | ServerConfig.ServerConfig>();
    const sql = yield* SqlClient.SqlClient;
    return {
      beforeRemoval: Effect.fn("SecondBrain.beforeRemoval")(
        function* (kind: "attachment" | "checkpoint", ids: readonly string[]) {
          if (!ids.length) return;
          const requested = yield* encodeIds(ids);
          const rows =
            kind === "attachment"
              ? yield* sql<BrainEntry>`SELECT e.* FROM second_brain_entries e WHERE next_attempt IS NOT NULL AND kind IN ('user','assistant')
        AND EXISTS (SELECT 1 FROM json_each(e.files_json) j WHERE json_extract(j.value,'$.id') IN (SELECT value FROM json_each(${requested}))) ORDER BY recorded_at`
              : yield* sql<BrainEntry>`SELECT e.* FROM second_brain_entries e WHERE next_attempt IS NOT NULL AND kind='checkpoint'
        AND (checkpoint_ref IN (SELECT value FROM json_each(${requested})) OR parent_ref IN (SELECT value FROM json_each(${requested}))) ORDER BY recorded_at`;
          const attachments = kind === "attachment" ? new Set(ids) : undefined;
          for (const entry of rows) yield* captureEntry(entry, attachments);
        },
        Effect.provide(services),
        Effect.mapError((cause) => new BrainFileError({ cause })),
      ),
    };
  }),
);
export const start = Effect.gen(function* () {
  const cycle = capturePending().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Second Brain file worker could not read its queue", { cause }).pipe(
        Effect.as(0),
      ),
    ),
    Effect.flatMap((count) => (count === 24 ? Effect.yieldNow : Effect.sleep("10 seconds"))),
  );
  yield* Effect.forkScoped(Effect.forever(cycle));
});

export const RecallResult = Schema.Struct({
  enabled: Schema.Boolean,
  entries: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      sourceId: Schema.String,
      kind: Schema.String,
      recordedAt: Schema.String,
      excerpt: Schema.String,
      filesPending: Schema.Boolean,
      copies: Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String })),
    }),
  ),
});
export const recall = Effect.fn("SecondBrain.recall")(function* (
  projectId: ProjectId,
  query: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const [project] =
    yield* sql`SELECT 1 FROM projection_projects WHERE project_id=${projectId} AND second_brain_enabled=1 AND deleted_at IS NULL`;
  if (!project) return { enabled: false, entries: [] };
  const needle = query.trim();
  const rows = yield* sql<{
    sourceId: string;
    threadId: string;
    kind: string;
    recordedAt: string;
    excerpt: string;
    filesPending: number;
  }>`
    SELECT e.source_id AS sourceId,e.thread_id AS threadId,e.kind,e.recorded_at AS recordedAt,
      substr(CASE WHEN e.kind='checkpoint' THEN (SELECT group_concat(json_extract(j.value,'$.path'),char(10)) FROM json_each(e.files_json) j) ELSE e.body END,
        max(1,instr(lower(e.body),lower(${needle}))-180),1800) AS excerpt,
      (e.next_attempt IS NOT NULL) AS filesPending FROM second_brain_entries e
    JOIN projection_projects p USING(project_id)
    WHERE e.project_id=${projectId} AND p.second_brain_enabled=1 AND p.deleted_at IS NULL
      AND (instr(lower(e.body),lower(${needle}))>0 OR instr(lower(e.files_json),lower(${needle}))>0)
    ORDER BY e.recorded_at DESC,e.source_id LIMIT 15`;
  const entries = yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const files = yield* sql<{
        name: string;
        file_key: string;
      }>`SELECT name,file_key FROM second_brain_copies
      WHERE project_id=${projectId} AND kind=${row.kind} AND source_id=${row.sourceId} ORDER BY name`;
      return {
        ...row,
        filesPending: row.filesPending === 1,
        copies: files.map((file) => ({
          name: file.name,
          path: brainFilePath(config.stateDir, projectId, file.file_key, file.name),
        })),
      };
    }),
  );
  return { enabled: true, entries };
});

import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as Persistence from "../persistence/Sqlite.ts";
import * as Brain from "./SecondBrain.ts";

it.layer(
  Layer.merge(
    Persistence.layerMemory,
    ServerConfig.layerTest("/", { prefix: "putman-brain-" }),
  ).pipe(Layer.provideMerge(NodeServices.layer)),
)("Second Brain", (it) => {
  it.effect(
    "remembers selected project history, preserves uploads and pauses capture and recall independently",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const first = ProjectId.make("first"),
          other = ProjectId.make("other");
        for (const id of [first, other]) {
          yield* sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES(${id},${id},'/repo','[]','1','1')`;
          yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json)
        VALUES(${id},${id},'test','codex','approval-required','default','1','1','{}')`;
        }
        const write = (
          id: string,
          thread: string,
          role: string,
          text: string,
          attachments: unknown[] = [],
          streaming = 0,
        ) => sql`INSERT INTO orchestration_v2_projection_messages(message_id,thread_id,role,streaming,created_at,updated_at,payload_json)
      VALUES(${id},${thread},${role},${streaming},'1','1',${JSON.stringify({ text, attachments, createdBy: role === "assistant" ? "agent" : "user" })})`;
        const attachment = {
          type: "file",
          id: "first-12345678-1234-1234-1234-123456789abc-pdf",
          name: "plan.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
        };
        const second = {
          ...attachment,
          id: "first-12345678-1234-1234-1234-123456789abd-pdf",
          name: "later.pdf",
        };
        const bytes = new Uint8Array([0, 1, 255, 0]);
        yield* fs.writeFile(config.attachmentsDir + "/" + attachment.id + ".pdf", bytes);
        yield* write("upload", first, "user", "See https://example.invalid/OneDrive/report", [
          second,
          attachment,
        ]);
        yield* write("excluded", other, "assistant", "private");
        assert.deepEqual(yield* Brain.recall(first, ""), { enabled: false, entries: [] });
        yield* sql`UPDATE projection_projects SET second_brain_enabled=1 WHERE project_id=${first}`;
        yield* write("reply", first, "assistant", "Prefer the blue theme", [], 1);
        assert.lengthOf((yield* Brain.recall(first, "blue")).entries, 0);
        yield* sql`UPDATE orchestration_v2_projection_messages SET streaming=0 WHERE message_id='reply'`;
        assert.lengthOf((yield* Brain.recall(first, "blue")).entries, 1);
        assert.lengthOf((yield* Brain.recall(first, "private")).entries, 0);
        yield* Effect.gen(function* () {
          const preserve = yield* Brain.PreserveSources;
          yield* preserve.beforeRemoval("attachment", [attachment.id]);
        }).pipe(Effect.provide(Brain.preservation));
        yield* fs.remove(config.attachmentsDir + "/" + attachment.id + ".pdf");
        yield* Brain.capturePending();
        const partial = (yield* Brain.recall(first, "OneDrive")).entries[0]!;
        assert.isTrue(partial.filesPending);
        assert.deepEqual(
          partial.copies.map((copy) => copy.name),
          ["plan.pdf"],
        );
        yield* fs.writeFile(config.attachmentsDir + "/" + second.id + ".pdf", bytes);
        yield* sql`UPDATE second_brain_entries SET next_attempt=0 WHERE source_id='upload'`;
        yield* Brain.capturePending();
        const saved = (yield* Brain.recall(first, "OneDrive")).entries[0]!;
        assert.isFalse(saved.filesPending);
        assert.deepEqual(
          saved.copies.map((copy) => copy.name),
          ["later.pdf", "plan.pdf"],
        );
        assert.deepEqual(yield* fs.readFile(saved.copies[0]!.path), bytes);
        // The production projection stores parentCheckpointId inside the checkpoint payload.
        const checkpoint = (id: string, ordinal: number, parent: string | null) => sql`
          INSERT INTO orchestration_v2_projection_checkpoints(checkpoint_id,thread_id,scope_id,node_id,ordinal_within_scope,status,captured_at,payload_json)
          VALUES(${id},${first},'scope','node',${ordinal},'ready','1',${JSON.stringify({
            ref: "refs/t3/orchestration-v2/checkpoints/scope/ordinal/" + ordinal,
            parentCheckpointId: parent,
            files: parent ? [{ path: "output.pdf" }] : [],
          })})`;
        yield* checkpoint("base", 0, null);
        yield* checkpoint("result", 1, "base");
        const [record] =
          yield* sql`SELECT parent_ref FROM second_brain_entries WHERE kind='checkpoint' AND source_id='result'`;
        assert.strictEqual(
          record?.parent_ref,
          "refs/t3/orchestration-v2/checkpoints/scope/ordinal/0",
        );
        yield* sql`UPDATE projection_projects SET second_brain_enabled=0 WHERE project_id=${first}`;
        yield* write("paused", first, "user", "this is paused");
        assert.isFalse((yield* Brain.recall(first, "")).enabled);
        assert.deepEqual(
          yield* sql`SELECT source_id FROM second_brain_entries WHERE source_id IN ('paused','excluded')`,
          [],
        );
      }),
  );
});

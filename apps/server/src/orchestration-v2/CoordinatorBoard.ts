import {
  CommandId,
  MessageId,
  ProjectCoordinatorError,
  ProjectId,
  ThreadId,
  coordinatorWebUrl,
  isListedThreadLineage,
  isProjectCoordinatorThread,
  type CoordinatorBoard,
  type OrchestrationV2RpcSchemas,
  type CoordinatorBoardAction,
  type ProductionDeployment,
  type CoordinatorBoardItem,
  type OrchestrationV2ThreadShell,
  ReviewAssets,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Projects from "../project/ProjectService.ts";
import type { PullRequestService } from "../pullRequest/PullRequestService.ts";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";
import { ensureCoordinator } from "./ProjectCoordinator.ts";
import {
  emptyAssets,
  findFileOverlaps,
  handoffPulls,
  releasePhase,
  revision,
} from "./coordinatorBoardState.ts";

type ReadCheckout = VcsStatusBroadcaster["Service"]["refreshLocalStatus"];
type Sql = SqlClient.SqlClient;
type ProjectsApi = Pick<Projects.ProjectService["Service"], "getById">;
type Pulls = Pick<
  PullRequestService["Service"],
  "coordinatorChange" | "coordinatorProduction" | "coordinatorIncludes" | "checks"
>;
const pullSchema = Schema.Struct({
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Int,
  url: Schema.NullOr(Schema.String),
});
const pullListJson = Schema.fromJsonString(Schema.Array(pullSchema));
const decodePulls = Schema.decodeUnknownEffect(pullListJson);
const encodePulls = Schema.encodeSync(pullListJson);
const snapshotSchema = Schema.Struct({
  scripts: Schema.Array(Schema.Struct({ name: Schema.String, status: Schema.String })),
  title: Schema.String,
  summary: Schema.String,
  files: Schema.Array(Schema.String),
  pulls: Schema.Array(pullSchema),
});
type Snapshot = typeof snapshotSchema.Type;
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(snapshotSchema));
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(snapshotSchema));
const decodeAssets = Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewAssets));
const encodeAssets = Schema.encodeSync(Schema.fromJsonString(ReviewAssets));
const encodeStrings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const isBoardError = Schema.is(ProjectCoordinatorError);
export type SaveHandoff = (
  projectId: ProjectId,
  id: MessageId,
  snapshot: Snapshot,
) => Effect.Effect<void, ProjectCoordinatorError>;
const error = (message: string) => new ProjectCoordinatorError({ message });
const boardError = (cause: unknown) =>
  isBoardError(cause) ? cause : error("The project review data could not be loaded.");
export const saveBoardHandoff =
  (sql: Sql): SaveHandoff =>
  (projectId, id, snapshot) =>
    sql`INSERT INTO coordinator_handoffs (project_id,message_id,snapshot_json) VALUES (${projectId},${id},${encodeSnapshot(snapshot)}) ON CONFLICT(message_id) DO NOTHING`.pipe(
      Effect.asVoid,
      Effect.mapError(boardError),
    );

const findProject = Effect.fn("CoordinatorBoard.project")(function* (
  projects: ProjectsApi,
  projectId: ProjectId,
) {
  const project = Option.getOrNull(yield* projects.getById(projectId));
  if (!project || project.archivedAt) return yield* error("Choose an active project.");
  return project;
});
const activeShells = Effect.fn("CoordinatorBoard.activeShells")(function* (
  threads: ThreadManagementServiceShape,
  projectId: ProjectId,
) {
  const shells = yield* threads.getShellSnapshot({
    projectId,
    location: "active",
    unsettledOnly: true,
  });
  return shells.threads.filter(
    (t) =>
      t.projectId === projectId &&
      isListedThreadLineage(t.lineage) &&
      !t.archivedAt &&
      !t.deletedAt,
  );
});

const overlapsFor = Effect.fn("CoordinatorBoard.overlapsFor")(function* (
  sql: Sql,
  shells: readonly OrchestrationV2ThreadShell[],
  root: string,
  readCheckout?: ReadCheckout,
) {
  const active = shells.filter((t) => !isProjectCoordinatorThread(t.projectId, t.id));
  if (active.length < 2) return [];
  const ids = encodeStrings(active.map((t) => t.id));
  // Only project paths leave SQLite. Large command output and patch bodies stay on the server.
  const edits = yield* sql<{ thread_id: string; path: string }>`
 WITH active(id) AS (SELECT value FROM json_each(${ids})),
 edits AS (SELECT thread_id,payload_json FROM orchestration_v2_projection_turn_items
 WHERE thread_id IN active AND type='file_change' AND status NOT IN ('failed','cancelled'))
 SELECT c.thread_id,json_extract(f.value,'$.path') AS path FROM orchestration_v2_projection_checkpoints c,
 json_each(c.payload_json,'$.files') f WHERE thread_id IN active AND c.status='ready'
 UNION SELECT thread_id,json_extract(payload_json,'$.fileName') FROM edits
 UNION SELECT thread_id,json_extract(f.value,'$.path') FROM edits,json_each(payload_json,'$.changes') f
 UNION SELECT thread_id,json_extract(f.value,'$.oldPath') FROM edits,json_each(payload_json,'$.changes') f`;
  const owned = active.filter(
    (t) =>
      t.worktreePath &&
      t.worktreePath !== root &&
      active.filter((peer) => peer.worktreePath === t.worktreePath).length === 1,
  );
  const local = readCheckout
    ? yield* Effect.forEach(
        owned,
        (t) =>
          readCheckout(t.worktreePath!).pipe(
            Effect.timeout("3 seconds"),
            Effect.map((status) =>
              status.workingTree.files.map((f) => ({ thread_id: t.id, path: f.path })),
            ),
            Effect.orElseSucceed(() => []),
          ),
        { concurrency: 2 },
      )
    : [];
  return findFileOverlaps(
    active.map((t) => ({ id: t.id, title: t.title, root: t.worktreePath ?? root })),
    [...edits, ...local.flat()],
  );
});
export const readCoordinatorOverlaps = Effect.fn("CoordinatorBoard.overlaps")(function* (
  projectId: ProjectId,
  sql: Sql,
  projects: ProjectsApi,
  threads: ThreadManagementServiceShape,
  readCheckout?: ReadCheckout,
) {
  const project = yield* findProject(projects, projectId);
  return yield* overlapsFor(
    sql,
    yield* activeShells(threads, projectId),
    project.workspaceRoot,
    readCheckout,
  );
}, Effect.mapError(boardError));

interface Row {
  id: string;
  coord: string;
  at: string;
  source: string;
  run: string;
  text: string;
  additional_pulls_json: string | null;
  snapshot_json: string | null;
  assets_json: string | null;
  assets_revision: string | null;
  approved_revision: string | null;
  prepared_revision: string | null;
}
const rowsFor = (sql: Sql, projectId: ProjectId, ids?: readonly MessageId[]) => sql<Row>`
 SELECT m.message_id id,m.thread_id coord,m.created_at at,json_extract(m.payload_json,'$.text') text,
 json_extract(substr(m.message_id,9),'$[1]') source,json_extract(substr(m.message_id,9),'$[2]') run,
 h.additional_pulls_json,h.snapshot_json,h.assets_json,h.assets_revision,h.approved_revision,h.prepared_revision
 FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_messages m ON m.thread_id=t.thread_id
 LEFT JOIN coordinator_handoffs h ON h.project_id=t.project_id AND h.message_id=m.message_id
 WHERE t.project_id=${projectId} AND t.deleted_at IS NULL AND m.role='user' AND m.message_id GLOB 'handoff:*'
 AND CASE WHEN json_valid(substr(m.message_id,9)) THEN json_extract(substr(m.message_id,9),'$[0]')=m.thread_id ELSE 0 END
 ${ids ? sql`AND m.message_id IN (SELECT value FROM json_each(${encodeStrings(ids)}))` : sql``}
 ORDER BY m.created_at DESC,m.message_id`;

const loadItems = Effect.fn("CoordinatorBoard.handoffs")(function* (
  projectId: ProjectId,
  sql: Sql,
  threads: ThreadManagementServiceShape,
  pulls: Pulls,
  ids?: readonly MessageId[],
) {
  const rows = (yield* rowsFor(sql, projectId, ids)).filter(
    (row) =>
      isProjectCoordinatorThread(projectId, ThreadId.make(row.coord)) &&
      typeof row.source === "string" &&
      typeof row.run === "string",
  );
  return yield* Effect.forEach(
    rows,
    Effect.fnUntraced(function* (row) {
      const threadId = ThreadId.make(row.source);
      let snapshot: Snapshot;
      if (row.snapshot_json) snapshot = yield* decodeSnapshot(row.snapshot_json);
      else {
        // v0.0.3 handoffs have a durable summary, and their archived feature chat usually has PR links.
        const source = yield* threads.getThreadShell(threadId);
        const original = source?.projectId === projectId ? source : null;
        const lines =
          row.text
            ?.split("\nRecorded project scripts for this turn:\n")[1]
            ?.split("\n\n")[0]
            ?.split("\n") ?? [];
        const scripts = lines.flatMap((line) => {
          const match = /^  (.+): (.+)$/.exec(line);
          return match ? [{ name: match[1]!, status: match[2]! }] : [];
        });
        snapshot = {
          scripts,
          title: original?.title ?? "Archived feature",
          summary:
            row.text
              ?.split("\nFeature chat result:\n")[1]
              ?.split("\n\nCoordinator next steps:")[0] ?? "",
          files:
            row.text
              ?.split("\n")
              .flatMap((line) => /^  (.+) \(\+\d+ \/ -\d+\)$/.exec(line)?.[1] ?? []) ?? [],
          pulls: original ? handoffPulls(original) : [],
        };
      }
      const additional = row.additional_pulls_json
        ? yield* decodePulls(row.additional_pulls_json)
        : [];
      const linked = yield* Effect.forEach(
        [...snapshot.pulls, ...additional],
        Effect.fnUntraced(function* (link) {
          const ref = {
            projectId,
            host: link.host,
            repository: link.repository,
            number: link.number,
          };
          const evidence = yield* pulls.coordinatorChange(ref, { bypassCache: ids !== undefined });
          const checks =
            evidence?.state === "OPEN"
              ? yield* pulls.checks(ref).pipe(
                  Effect.map((c) => c?.checks ?? []),
                  Effect.orElseSucceed(() => []),
                )
              : [];
          return { ...link, evidence, checks };
        }),
      );
      const base = revision([
        row.id,
        linked.map((p) => [p.repository, p.number, p.evidence?.head]),
      ]);
      const manualAssets: ReviewAssets =
        row.assets_json && row.assets_revision === base
          ? yield* decodeAssets(row.assets_json)
          : emptyAssets;
      const assets = {
        preview: manualAssets.preview,
        before:
          manualAssets.before ?? linked.find((p) => p.evidence?.before)?.evidence?.before ?? null,
        after: manualAssets.after ?? linked.find((p) => p.evidence?.after)?.evidence?.after ?? null,
      };
      const token = revision([base, assets, linked.map((p) => p.evidence?.preview ?? null)]);
      const approved = row.approved_revision === token;
      return {
        live: null,
        id: MessageId.make(row.id),
        coordinatorId: ThreadId.make(row.coord),
        threadId,
        title: snapshot.title,
        summary: snapshot.summary,
        scripts: snapshot.scripts,
        files: snapshot.files,
        at: row.at,
        pulls: linked,
        revision: token,
        assets,
        approved,
        prepared: row.prepared_revision === token,
        phase: releasePhase(
          linked.map((p) => p.evidence),
          assets,
          approved,
          snapshot.scripts,
        ),
        base,
        storedAssets: row.assets_json,
        storedPulls: row.additional_pulls_json,
        additional,
      };
    }),
    { concurrency: 3 },
  );
});

const currentProduction = Effect.fn("CoordinatorBoard.currentProduction")(function* (
  projectId: ProjectId,
  item: CoordinatorBoardItem,
  deployed: ProductionDeployment | undefined,
  pulls: Pulls,
) {
  if (!deployed || !item.pulls.length || !item.pulls.every((p) => p.evidence?.state === "MERGED"))
    return null;
  const included = yield* Effect.forEach(item.pulls, (p) => {
    const sha = p.evidence?.merge;
    const host = p.url ? new URL(p.url).host : null;
    if (
      !sha ||
      !host ||
      host.toLowerCase() !== deployed.host.toLowerCase() ||
      p.repository.toLowerCase() !== deployed.repository.toLowerCase()
    )
      return Effect.succeed(null);
    return sha === deployed.revision
      ? Effect.succeed(true)
      : pulls.coordinatorIncludes({
          projectId,
          host,
          repository: p.repository,
          number: p.number,
          base: sha,
          head: deployed.revision,
        });
  });
  return included.every((v) => v === true) ? true : included.includes(false) ? false : null;
});

export const readCoordinatorBoard = Effect.fn("CoordinatorBoard.read")(function* (
  projectId: ProjectId,
  sql: Sql,
  projects: ProjectsApi,
  threads: ThreadManagementServiceShape,
  pulls: Pulls,
  readCheckout?: ReadCheckout,
) {
  const project = yield* findProject(projects, projectId);
  const shells = yield* activeShells(threads, projectId);
  const items = yield* loadItems(projectId, sql, threads, pulls);
  const production = yield* pulls.coordinatorProduction(projectId);
  const deployed = production?.find((d) => d.state === "SUCCESS");
  const resolved = yield* Effect.forEach(
    items,
    Effect.fnUntraced(function* (item) {
      const {
        base: _base,
        storedAssets: _stored,
        storedPulls: _pulls,
        additional: _additional,
        ...visible
      } = item;
      const live = yield* currentProduction(projectId, visible, deployed, pulls);
      return { ...visible, live, phase: live ? ("deployed" as const) : visible.phase };
    }),
    { concurrency: 3 },
  );
  const questions: CoordinatorBoard["questions"] = shells.flatMap((t) =>
    t.pendingRuntimeRequest || t.hasActionableProposedPlan
      ? [
          {
            id: t.id,
            title: t.title,
            kind: t.pendingRuntimeRequest
              ? t.pendingRuntimeRequest.kind === "user_input"
                ? ("question" as const)
                : ("approval" as const)
              : ("plan" as const),
          },
        ]
      : [],
  );
  return {
    items: resolved,
    questions,
    overlaps: yield* overlapsFor(sql, shells, project.workspaceRoot, readCheckout),
    production,
  };
}, Effect.mapError(boardError));

export const actOnCoordinatorBoard = Effect.fn("CoordinatorBoard.act")(function* (
  input: CoordinatorBoardAction,
  sql: Sql,
  projects: ProjectsApi,
  threads: ThreadManagementServiceShape,
  pulls: Pulls,
) {
  const project = yield* findProject(projects, input.projectId);
  const requested = input.type === "prepare" ? input.items : [input.item];
  const rows = yield* loadItems(
    input.projectId,
    sql,
    threads,
    pulls,
    requested.map((r) => r.id),
  );
  const selected = Array.from(new Map(requested.map((i) => [i.id, i])).values()).map((i) =>
    rows.find((r) => r.id === i.id && r.revision === i.revision),
  );
  if (!selected.length || selected.some((s) => !s))
    return yield* error("The handoff changed. Refresh the release board and review it again.");
  const items = selected.flatMap((i) => (i ? [i] : []));
  const first = items[0]!;
  for (const item of items)
    yield* sql`INSERT OR IGNORE INTO coordinator_handoffs (message_id,project_id) VALUES (${item.id},${input.projectId})`;
  if (input.type === "prepare") {
    if (items.some((i) => i.phase !== "ready" && i.phase !== "merged"))
      return yield* error("Only ready or merged changes can be prepared.");
    if (items.some((i) => i.phase === "merged")) {
      const production = yield* pulls.coordinatorProduction(input.projectId);
      const deployed = production?.find((d) => d.state === "SUCCESS");
      const live = yield* Effect.forEach(
        items,
        (i) => currentProduction(input.projectId, i, deployed, pulls),
        { concurrency: 3 },
      );
      if (live.includes(true))
        return yield* error("A selected change is already live. Refresh the release board.");
    }
    const key = revision([input.projectId, items.map((i) => [i.id, i.revision]).sort()]);
    const previous = yield* threads.getThreadShell(first.coordinatorId);
    if (!previous || previous.projectId !== input.projectId)
      return yield* error("The project coordinator could not be found.");
    const threadId =
      previous.archivedAt !== null
        ? yield* ensureCoordinator(
            threads,
            project,
            previous.modelSelection,
            () => Effect.undefined,
          )
        : previous.id;
    const text = [
      "Prepare a release plan for only the selected handoffs below. Verify their exact revisions and checks, list blockers and draft release notes. Stop after the plan. Any merge, tag, publication or deployment requires a separate request.",
      ...items.map((i: CoordinatorBoardItem) =>
        JSON.stringify({
          handoff: i.id,
          feature: i.title,
          featureThread: i.threadId,
          pulls: i.pulls.map((p) => ({
            url: p.url,
            head: p.evidence?.head,
            merge: p.evidence?.merge,
          })),
        }),
      ),
    ].join("\n");
    yield* threads.sendToThread({
      projectId: input.projectId,
      threadId,
      messageId: MessageId.make("prepare:" + key),
      commandId: CommandId.make("prepare:" + key),
      text,
      attachments: [],
      mode: "queue",
      createdBy: "user",
      creationSource: "web",
    });
    yield* sql.withTransaction(
      Effect.forEach(
        items,
        (i) =>
          sql`UPDATE coordinator_handoffs SET prepared_revision=${i.revision} WHERE project_id=${input.projectId} AND message_id=${i.id} AND assets_json IS ${i.storedAssets}`,
      ),
    );
    return { threadId };
  }
  if (input.type === "linkPull") {
    const url = coordinatorWebUrl(input.url);
    const parsed = url ? new URL(url) : null;
    const match = parsed && /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(parsed.pathname);
    if (!parsed || !match || !Number.isSafeInteger(Number(match[3])))
      return yield* error("Enter a GitHub pull request URL.");
    const link = {
      host: parsed.host,
      repository: match[1] + "/" + match[2],
      number: Number(match[3]),
      url: parsed.origin + parsed.pathname.replace(/\/$/, ""),
    };
    if (
      first.pulls.some(
        (p) =>
          p.repository.toLowerCase() === link.repository.toLowerCase() &&
          p.number === link.number &&
          p.host === link.host,
      )
    )
      return { threadId: first.coordinatorId };
    const evidence = yield* pulls.coordinatorChange({ projectId: input.projectId, ...link });
    if (!evidence) return yield* error("This pull request could not be verified for the project.");
    const updated =
      yield* sql`UPDATE coordinator_handoffs SET additional_pulls_json=${encodePulls([...first.additional, link])},approved_revision=NULL,prepared_revision=NULL WHERE message_id=${first.id} AND project_id=${input.projectId} AND additional_pulls_json IS ${first.storedPulls} RETURNING message_id`;
    if (!updated.length)
      return yield* error("The linked pull requests changed. Refresh and try again.");
    return { threadId: first.coordinatorId };
  }
  const updated =
    input.type === "approve"
      ? yield* sql`UPDATE coordinator_handoffs SET approved_revision=${first.revision} WHERE message_id=${first.id} AND project_id=${input.projectId} AND assets_json IS ${first.storedAssets} AND additional_pulls_json IS ${first.storedPulls} RETURNING message_id`
      : yield* sql`UPDATE coordinator_handoffs SET assets_json=${encodeAssets({ preview: coordinatorWebUrl(input.assets.preview), before: coordinatorWebUrl(input.assets.before), after: coordinatorWebUrl(input.assets.after) })},assets_revision=${first.base},approved_revision=NULL,prepared_revision=NULL WHERE message_id=${first.id} AND project_id=${input.projectId} AND assets_json IS ${first.storedAssets} AND additional_pulls_json IS ${first.storedPulls} RETURNING message_id`;
  if (!updated.length)
    return yield* error("Another reviewer changed this handoff. Refresh and try again.");
  return { threadId: first.coordinatorId };
}, Effect.mapError(boardError));

export const retryCoordinatorChecks = Effect.fn("CoordinatorBoard.retryChecks")(function* (
  input: typeof OrchestrationV2RpcSchemas.coordinatorRetry.input.Type,
  pulls: Pick<PullRequestService["Service"], "summary" | "rerunChecks">,
) {
  const current = yield* pulls.summary(input, { bypassCache: true });
  if (!current || current.headSha !== input.head || current.state !== "open")
    return yield* error("The pull request changed. Refresh before retrying CI.");
  const results = yield* pulls.rerunChecks(input);
  const count = results.filter((r) => r.rerun).length;
  if (!count)
    return yield* error(
      results.find((r) => r.detail)?.detail ?? "There are no failed checks available to retry.",
    );
  return { count };
}, Effect.mapError(boardError));

import {
  audit,
  changeTeam,
  isTeamAction,
  listHolds,
  matchingHolds,
  readTeam,
  readLimits,
  teamAccess,
  workerActor,
  type BoardActor,
} from "./CoordinatorTeam.ts";
import {
  CommandId,
  MessageId,
  HandoffUsage,
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
> &
  Partial<
    Pick<
      PullRequestService["Service"],
      | "checkLogs"
      | "dispatchCoordinatorRelease"
      | "coordinatorRange"
      | "list"
      | "coordinatorSinceProduction"
    >
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
  usage: Schema.optional(HandoffUsage),
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
const encodeNumbers = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Int)));
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
  (
    sql: Sql,
    estimate?: NonNullable<
      import("../usage/UsageService.ts").UsageService["Service"]["estimateCoordinatorTurn"]
    >,
  ): SaveHandoff =>
  (projectId, id, inputSnapshot) =>
    Effect.gen(function* () {
      const [run] = yield* sql<{
        model: string;
        quick: number;
      }>`SELECT json_extract(payload_json,'$.modelSelection.model') model, json_type(payload_json,'$.coordinatorWorkModel') IS NOT NULL quick FROM orchestration_v2_projection_runs WHERE run_id=json_extract(substr(${id},9),'$[2]') AND thread_id=json_extract(substr(${id},9),'$[1]')`;
      const turns = yield* sql<{
        model: string | null;
        input: number | null;
        output: number | null;
        cached: number | null;
        writes: number | null;
        reasoning: number | null;
        complete: number;
      }>`SELECT json_extract(p.payload_json,'$.model') model,
      json_extract(p.payload_json,'$.turnTokenUsage.inputTokens') input,json_extract(p.payload_json,'$.turnTokenUsage.outputTokens') output,
      json_extract(p.payload_json,'$.turnTokenUsage.cachedInputTokens') cached,json_extract(p.payload_json,'$.turnTokenUsage.cacheCreationTokens') writes,
      json_extract(p.payload_json,'$.turnTokenUsage.reasoningTokens') reasoning,
      json_extract(p.payload_json,'$.turnTokenUsage.usageStatus')='complete' complete
      FROM orchestration_v2_projection_provider_turns p JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id=p.run_attempt_id
      WHERE a.run_id=json_extract(substr(${id},9),'$[2]') AND a.thread_id=json_extract(substr(${id},9),'$[1]')`;
      const prices =
        run && estimate
          ? yield* Effect.forEach(turns, (t) => {
              if (!t.complete || t.input === null || t.output === null) return Effect.succeed(null);
              return estimate(t.model ?? run.model, {
                uncachedInputTokens: Math.max(0, t.input - (t.cached ?? 0) - (t.writes ?? 0)),
                cachedInputTokens: t.cached ?? 0,
                cacheCreationTokens: t.writes ?? 0,
                outputTokens: t.output,
                reasoningTokens: t.reasoning ?? 0,
              });
            })
          : [];
      const usage: HandoffUsage | undefined = run?.model
        ? {
            models: [
              ...new Set(turns.length ? turns.map((t) => t.model ?? run.model) : [run.model]),
            ],
            route: run.quick ? "routine" : "feature",
            estimatedUsd:
              prices.length && prices.every((p): p is number => p !== null)
                ? prices.reduce((a, b) => a + b, 0)
                : null,
          }
        : undefined;
      const snapshot = { ...inputSnapshot, ...(usage ? { usage } : {}) };
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const added =
            yield* sql`INSERT INTO coordinator_handoffs (project_id,message_id,snapshot_json) VALUES (${projectId},${id},${encodeSnapshot(snapshot)}) ON CONFLICT(message_id) DO NOTHING RETURNING message_id`;
          if (!added.length || !id.startsWith("handoff:")) return;
          const [prior] = yield* sql<{
            message_id: string;
            snapshot_json: string;
            additional_pulls_json: string | null;
          }>`SELECT message_id,snapshot_json,additional_pulls_json FROM coordinator_handoffs
        WHERE project_id=${projectId} AND repair_base IS NOT NULL AND message_id GLOB 'handoff:*' AND snapshot_json IS NOT NULL
        AND json_extract(substr(message_id,9),'$[1]')=json_extract(substr(${id},9),'$[1]') ORDER BY rowid DESC LIMIT 1`;
          if (!prior) return;
          const old = yield* decodeSnapshot(prior.snapshot_json);
          const known = [
            ...old.pulls,
            ...(prior.additional_pulls_json ? yield* decodePulls(prior.additional_pulls_json) : []),
          ];
          if (
            !snapshot.pulls.some((p) =>
              known.some(
                (q) =>
                  p.host === q.host &&
                  p.number === q.number &&
                  p.repository.toLowerCase() === q.repository.toLowerCase(),
              ),
            )
          )
            return;
          yield* sql`UPDATE coordinator_handoffs SET snapshot_json=${encodeSnapshot(snapshot)}, approved_revision=NULL,prepared_revision=NULL,released_revision=NULL WHERE message_id=${prior.message_id}`;
          yield* sql`UPDATE coordinator_handoffs SET continuation_of=${prior.message_id} WHERE message_id=${id}`;
        }),
      );
    }).pipe(Effect.mapError(boardError));

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
  approved_by: string | null;
  approved_at: string | null;
  prepared_revision: string | null;
  external_thread: string | null;
  repair_base: string | null;
  released_revision: string | null;
}
const rowsFor = (sql: Sql, projectId: ProjectId, ids?: readonly MessageId[]) => sql<Row>`
 SELECT m.message_id id,m.thread_id coord,m.created_at at,json_extract(m.payload_json,'$.text') text,
 json_extract(substr(m.message_id,9),'$[1]') source,json_extract(substr(m.message_id,9),'$[2]') run,
 h.additional_pulls_json,h.snapshot_json,h.assets_json,h.assets_revision,h.approved_revision,h.approved_by,h.approved_at,h.prepared_revision,h.external_thread,h.repair_base,h.released_revision
 FROM orchestration_v2_projection_threads t JOIN orchestration_v2_projection_messages m ON m.thread_id=t.thread_id
 LEFT JOIN coordinator_handoffs h ON h.project_id=t.project_id AND h.message_id=m.message_id
 WHERE t.project_id=${projectId} AND t.deleted_at IS NULL AND h.continuation_of IS NULL AND m.role='user' AND m.message_id GLOB 'handoff:*'
 AND CASE WHEN json_valid(substr(m.message_id,9)) THEN json_extract(substr(m.message_id,9),'$[0]')=m.thread_id ELSE 0 END
 ${ids ? sql`AND m.message_id IN (SELECT value FROM json_each(${encodeStrings(ids)}))` : sql``}
 UNION ALL
 SELECT h.message_id,h.external_thread,h.received_at,'',h.external_thread,'external',
 h.additional_pulls_json,h.snapshot_json,h.assets_json,h.assets_revision,h.approved_revision,h.approved_by,h.approved_at,h.prepared_revision,
 h.external_thread,h.repair_base,h.released_revision FROM coordinator_handoffs h
 JOIN orchestration_v2_projection_threads t ON t.thread_id=h.external_thread AND t.project_id=h.project_id AND t.deleted_at IS NULL
 WHERE h.project_id=${projectId} AND h.external_thread IS NOT NULL
 ${ids ? sql`AND h.message_id IN (SELECT value FROM json_each(${encodeStrings(ids)}))` : sql``}
 ORDER BY at DESC,id`;

function pullLink(value: string) {
  const safe = coordinatorWebUrl(value.trim());
  const url = safe ? new URL(safe) : null;
  const parts = url && /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (!url || !parts || !Number.isSafeInteger(Number(parts[3]))) return null;
  return {
    host: url.host,
    repository: (parts[1] + "/" + parts[2]).toLowerCase(),
    number: Number(parts[3]),
    url:
      url.origin +
      "/" +
      parts[1]!.toLowerCase() +
      "/" +
      parts[2]!.toLowerCase() +
      "/pull/" +
      parts[3],
  };
}

const openProjectCoordinator = Effect.fn("CoordinatorBoard.openProjectCoordinator")(function* (
  project: import("@t3tools/contracts").Project,
  sql: Sql,
  threads: ThreadManagementServiceShape,
) {
  const projectId = project.id;
  const latest = yield* sql<{
    thread_id: string;
  }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE project_id=${projectId} AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`;
  const previous = latest[0]
    ? yield* threads.getThreadShell(ThreadId.make(latest[0].thread_id))
    : null;
  const model = project.defaultModelSelection ?? previous?.modelSelection;
  if (!model) return yield* error("Open the project coordinator once to select its model.");
  return yield* ensureCoordinator(threads, project, model, () => Effect.undefined);
});
// The Hub has already delivered its message. Desktop submissions also wake the coordinator.
export const submitCoordinatorPull = Effect.fn("CoordinatorBoard.submitPull")(function* (
  projectId: ProjectId,
  url: string,
  sql: Sql,
  projects: ProjectsApi,
  threads: ThreadManagementServiceShape,
  pulls: Pick<Pulls, "coordinatorChange">,
  deliveredTo?: ThreadId,
) {
  const project = yield* findProject(projects, projectId);
  const shorthand = /^#?([1-9]\d*)$/.exec(url.trim());
  const link = pullLink(
    shorthand && project.repositoryIdentity?.canonicalKey
      ? "https://" + project.repositoryIdentity.canonicalKey + "/pull/" + shorthand[1]
      : url,
  );
  if (!link) return yield* error("Enter a GitHub pull request URL.");
  const identity = project.repositoryIdentity?.canonicalKey.toLowerCase();
  if (!identity || identity !== link.host.toLowerCase() + "/" + link.repository)
    return yield* error("This pull request belongs to another project.");
  const [feature] = yield* sql<{
    coord: string;
  }>`SELECT m.thread_id coord FROM coordinator_handoffs h
    JOIN orchestration_v2_projection_messages m ON m.message_id=h.message_id
    JOIN orchestration_v2_projection_threads t ON t.thread_id=m.thread_id AND t.deleted_at IS NULL AND t.project_id=h.project_id
    WHERE h.project_id=${projectId} AND h.external_thread IS NULL AND h.continuation_of IS NULL
    AND (EXISTS(SELECT 1 FROM json_each(h.snapshot_json,'$.pulls') p WHERE lower(json_extract(p.value,'$.url'))=lower(${link.url}))
      OR EXISTS(SELECT 1 FROM json_each(h.additional_pulls_json) p WHERE lower(json_extract(p.value,'$.url'))=lower(${link.url}))) LIMIT 1`;
  if (feature) return { threadId: ThreadId.make(feature.coord) };
  const evidence = yield* pulls.coordinatorChange({ projectId, ...link }, { bypassCache: true });
  if (!evidence) return yield* error("This pull request could not be verified for this project.");
  let target = deliveredTo;
  if (target) {
    const shell = yield* threads.getThreadShell(target);
    if (!shell || shell.deletedAt || shell.projectId !== projectId)
      return yield* error("The coordinator is unavailable.");
  } else {
    target = yield* openProjectCoordinator(project, sql, threads);
  }
  const id = MessageId.make(
    "queue-pr:" + revision([projectId, link.host, link.repository, link.number]),
  );
  const title = evidence.title ?? link.repository + " #" + link.number;
  const snap = encodeSnapshot({ title, summary: link.url, files: [], scripts: [], pulls: [link] });
  const [record] = yield* sql<{
    external_thread: string;
    delivered: number;
  }>`INSERT INTO coordinator_handoffs
   (project_id,message_id,external_thread,received_at,snapshot_json) VALUES(${projectId},${id},${target},strftime('%Y-%m-%dT%H:%M:%fZ','now'),${snap})
   ON CONFLICT(message_id) DO UPDATE SET snapshot_json=excluded.snapshot_json RETURNING external_thread,delivered`;
  const threadId = ThreadId.make(record!.external_thread);
  if (!deliveredTo && !record!.delivered) {
    yield* threads.sendToThread({
      projectId,
      threadId,
      messageId: id,
      commandId: CommandId.make("deliver:" + id),
      text: "Review this submitted pull request and its acceptance criteria: " + link.url,
      attachments: [],
      mode: "queue",
      createdBy: "user",
      creationSource: "web",
    });
  }
  if (!record!.delivered)
    yield* sql`UPDATE coordinator_handoffs SET delivered=1 WHERE message_id=${id}`;
  return { threadId };
}, Effect.mapError(boardError));

const loadItems = Effect.fn("CoordinatorBoard.handoffs")(function* (
  projectId: ProjectId,
  sql: Sql,
  threads: ThreadManagementServiceShape,
  pulls: Pulls,
  ids?: readonly MessageId[],
) {
  const rows = (yield* rowsFor(sql, projectId, ids)).filter(
    (row) =>
      (row.external_thread === row.coord ||
        isProjectCoordinatorThread(projectId, ThreadId.make(row.coord))) &&
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
              ? (evidence.headChecks ??
                (yield* pulls.checks(ref).pipe(
                  Effect.map((c) => c?.checks ?? []),
                  Effect.orElseSucceed(() => []),
                )))
              : (evidence?.headChecks ?? []);
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
      const originalToken = [base, assets, linked.map((p) => p.evidence?.preview ?? null)];
      const criteria = linked.flatMap((p) => p.evidence?.criteria ?? []);
      const token = revision(criteria.length ? [...originalToken, criteria] : originalToken);
      const approved = row.approved_revision === token && !!row.approved_by;
      return {
        ...(snapshot.usage ? { usage: snapshot.usage } : {}),
        external: row.external_thread !== null,
        ...(row.repair_base
          ? {
              repairState: row.repair_base === base ? ("sent" as const) : ("needs-review" as const),
            }
          : {}),
        releaseRequested: row.released_revision === token,
        live: null,
        id: MessageId.make(row.id),
        coordinatorId: ThreadId.make(row.coord),
        sourceRun: row.run,
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
        approvedBy: approved ? row.approved_by : null,
        approvedAt: approved ? row.approved_at : null,
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
  actor?: BoardActor,
  withGithub = false,
) {
  const project = yield* findProject(projects, projectId);
  const shells = yield* activeShells(threads, projectId);
  const items = yield* loadItems(projectId, sql, threads, pulls);
  const [policy] = yield* sql<{
    instructions: string;
    auto_repair: number;
    github_release: number;
  }>`SELECT instructions,auto_repair,github_release FROM coordinator_playbooks WHERE project_id=${projectId}`;
  const production = yield* pulls.coordinatorProduction(projectId);
  const deployed = production?.find((d) => d.state === "SUCCESS");
  const resolved = yield* Effect.forEach(
    items,
    Effect.fnUntraced(function* (item) {
      const {
        base: _base,
        sourceRun: _run,
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
  const open =
    withGithub && pulls.list
      ? yield* pulls
          .list({ projectId, state: "open", limit: 100 })
          .pipe(Effect.orElseSucceed(() => null))
      : null;
  const github = withGithub
    ? {
        title: project.title,
        open:
          open &&
          !open.errors.length &&
          (open.entries.some((p) => p.provider === "github") ||
            open.providers.some((p) => p.kind === "github" && p.configured))
            ? open.entries.filter((p) => p.provider === "github" && p.projectId === projectId)
            : null,
        truncated: open?.truncated ?? false,
        unshipped:
          deployed && pulls.coordinatorSinceProduction
            ? yield* pulls.coordinatorSinceProduction(projectId, deployed.revision)
            : null,
      }
    : undefined;
  return {
    ...(github ? { github } : {}),
    ...(actor
      ? {
          team: yield* readTeam(sql, projectId, actor, [
            ...new Map(
              [
                ...shells
                  .filter((t) => !isProjectCoordinatorThread(projectId, t.id))
                  .map((t) => ({ id: t.id, title: t.title })),
                ...items
                  .filter((i) => !i.external)
                  .map((i) => ({ id: i.threadId, title: i.title })),
              ].map((t) => [t.id, t]),
            ).values(),
          ]),
        }
      : {}),
    // When a feature chat arrives after a teammate submits its PR, keep the actionable chat row.
    items: resolved.filter(
      (item) =>
        !item.external ||
        !resolved.some(
          (peer) =>
            !peer.external &&
            item.pulls.every((p) =>
              peer.pulls.some((link) => link.url?.toLowerCase() === p.url?.toLowerCase()),
            ),
        ),
    ),
    playbook: policy?.instructions ?? "",
    autoRepair: policy?.auto_repair === 1,
    githubRelease: policy?.github_release === 1,
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
  actor: BoardActor,
) {
  const project = yield* findProject(projects, input.projectId);
  if (isTeamAction(input))
    return yield* sql.withTransaction(changeTeam(sql, input, actor, threads));
  const rights = yield* teamAccess(sql, input.projectId, actor);
  actor = rights.actor;
  if (input.type === "approve" && !rights.approve)
    return yield* error("Project approval permission is required.");
  if ((input.type === "release" || input.type === "playbook") && !rights.release)
    return yield* error("Project release permission is required.");
  if (!["inspectRelease", "approve", "release", "playbook"].includes(input.type) && !rights.submit)
    return yield* error("Project submission permission is required.");
  if (input.type === "askPull") {
    const link = pullLink(input.url);
    if (
      !link ||
      project.repositoryIdentity?.canonicalKey.toLowerCase() !==
        (link.host + "/" + link.repository).toLowerCase()
    )
      return yield* error("Choose a pull request from this project.");
    const change = yield* pulls.coordinatorChange(
      { projectId: input.projectId, ...link },
      { bypassCache: true },
    );
    if (!change) return yield* error("This pull request could not be verified.");
    const dest = yield* openProjectCoordinator(project, sql, threads);
    const id = "ask-pr:" + revision([input.projectId, actor.key, link.url, input.requestId]);
    yield* threads.sendToThread({
      projectId: input.projectId,
      threadId: dest,
      messageId: MessageId.make(id),
      commandId: CommandId.make(id),
      mode: "queue",
      createdBy: "user",
      creationSource: "web",
      attachments: [],
      text: ["Question about " + link.url + " @ " + change.head, change.title ?? "", input.question]
        .filter(Boolean)
        .join("\n"),
    });
    return { threadId: dest };
  }
  if (input.type === "submitPull")
    return yield* submitCoordinatorPull(input.projectId, input.url, sql, projects, threads, pulls);
  if (input.type === "playbook") {
    const coordinator = (yield* activeShells(threads, input.projectId)).find((t) =>
      isProjectCoordinatorThread(input.projectId, t.id),
    );
    const policyThread =
      coordinator?.id ?? ThreadId.make("coordinator-" + encodeURIComponent(input.projectId) + "-0");
    yield* sql`INSERT INTO coordinator_playbooks(project_id,instructions,auto_repair,github_release) VALUES(${input.projectId},${input.instructions.trim()},${input.autoRepair ? 1 : 0},${input.githubRelease ? 1 : 0}) ON CONFLICT(project_id) DO UPDATE SET instructions=excluded.instructions,auto_repair=excluded.auto_repair,github_release=excluded.github_release`;
    return { threadId: policyThread };
  }
  const requested =
    input.type === "prepare" || input.type === "release" || input.type === "inspectRelease"
      ? input.items
      : [input.item];
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
  let reviewedManifest: import("@t3tools/contracts").ShipManifest | undefined;
  if (input.type === "inspectRelease" || input.type === "release") {
    const refs = items.flatMap((i) => i.pulls);
    const ref = refs[0];
    const head = ref?.evidence?.defaultRevision,
      branch = ref?.evidence?.defaultBranch;
    if (
      !ref ||
      !head ||
      !branch ||
      !refs.every(
        (p) =>
          p.repository.toLowerCase() === ref.repository.toLowerCase() &&
          p.host === ref.host &&
          p.evidence?.defaultRevision === head &&
          p.evidence.state === "MERGED",
      ) ||
      project.repositoryIdentity?.canonicalKey.toLowerCase() !==
        ref.host.toLowerCase() + "/" + ref.repository.toLowerCase()
    )
      return yield* error("Select merged changes from the project's current default branch.");
    const production = yield* pulls.coordinatorProduction(input.projectId);
    const base = production?.find(
      (d) =>
        d.state === "SUCCESS" &&
        d.repository.toLowerCase() === ref.repository.toLowerCase() &&
        d.host === ref.host,
    )?.revision;
    if (!base || !pulls.coordinatorRange)
      return yield* error(
        "A verified production baseline and repository comparison are required to inspect a release.",
      );
    const range = yield* pulls.coordinatorRange({
      projectId: input.projectId,
      host: ref.host,
      repository: ref.repository,
      number: ref.number,
      base,
      head,
      branch,
    });
    if (
      !range ||
      !range.commits.length ||
      refs.some(
        (p) =>
          !range.commits.some((c) => c.pulls.includes(p.number) || c.sha === p.evidence?.merge),
      )
    )
      return yield* error(
        "The production comparison is empty, divergent or incomplete. Verify the production baseline and compare range.",
      );
    const holds = yield* listHolds(sql, input.projectId);
    const affected = matchingHolds(holds, range.files, [
      ...refs.map((p) => p.number),
      ...range.commits.flatMap((c) => c.pulls),
    ]);
    const manifest = {
      ...range,
      repository: ref.repository,
      base,
      head,
      holds: affected,
      token: revision([base, head, range, holds, items.map((i) => [i.id, i.revision]).sort()]),
    };
    if (input.type === "inspectRelease") return { threadId: first.coordinatorId, manifest };
    if (input.manifest !== manifest.token || affected.length)
      return yield* error(
        affected.length
          ? "Release is on hold: " + affected.join(", ")
          : "Review the current release manifest before confirming.",
      );
    reviewedManifest = manifest;
  }
  if (input.type === "feedback") {
    const { previewOrigin } = yield* readLimits(sql, input.projectId);
    const link = first.pulls.find(
      (p) =>
        p.evidence?.preview === input.preview &&
        p.evidence?.head &&
        new URL(input.preview).pathname.split("/").includes(p.evidence.head),
    );
    if (
      !link ||
      !previewOrigin ||
      coordinatorWebUrl(input.preview) === null ||
      new URL(input.preview).origin !== previewOrigin
    )
      return yield* error(
        "This revision has no verified preview on the configured private origin.",
      );
    const id = revision([input.projectId, first.id, actor.key, input.requestId]);
    const dest = first.external ? first.coordinatorId : first.threadId;
    const source = yield* threads.getThreadShell(dest);
    if (!source || source.deletedAt || source.projectId !== input.projectId)
      return yield* error("The originating chat is unavailable.");
    if (source.archivedAt)
      yield* threads.dispatch({
        type: "thread.unarchive",
        threadId: dest,
        commandId: CommandId.make("feedback-open:" + id),
      });
    yield* threads.sendToThread({
      projectId: input.projectId,
      threadId: dest,
      messageId: MessageId.make("preview:" + id),
      commandId: CommandId.make("preview:" + id),
      mode: "queue",
      createdBy: "user",
      creationSource: "web",
      attachments: [],
      text: [
        "Preview feedback from " + actor.label,
        link.url + " @ " + link.evidence?.head,
        input.preview,
        "Screen: " + input.screen,
        input.note,
      ].join("\n"),
    });
    return { threadId: dest };
  }
  if (input.type === "repair") {
    if (first.phase !== "failed" || first.external || first.repairState)
      return yield* error(
        "This handoff is ineligible for automatic repair. Review the failure in its chat.",
      );
    const source = yield* threads.getThreadShell(first.threadId);
    if (!source || source.deletedAt || source.projectId !== input.projectId)
      return yield* error("The feature chat is unavailable.");
    const target = first.pulls.find(
      (p) =>
        p.evidence?.state === "OPEN" &&
        ["ERROR", "FAILURE"].includes(p.evidence.checks ?? "") &&
        (actor.key !== workerActor.key || p.evidence.ciDiagnosis?.kind === "pr"),
    );
    if (!target?.evidence?.head) return yield* error("No failed open PR was verified.");
    if (actor.key === workerActor.key && target.evidence.ciDiagnosis?.kind !== "pr")
      return yield* error("Automatic repair requires a verified PR-specific CI failure.");
    const repairId = MessageId.make("repair:" + first.base);
    const previous = yield* threads.getProjectThreadRecords(
      { projectId: input.projectId, threadId: source.id },
      ["messages"],
      { messageIds: [repairId] },
    );
    if (previous.messages.length) {
      yield* sql`UPDATE coordinator_handoffs SET repair_base=${first.base} WHERE message_id=${first.id} AND repair_base IS NULL`;
      return { threadId: source.id };
    }
    if (source.latestRunId && source.latestRunId !== first.sourceRun)
      return yield* error("The feature chat already has newer work. Review the failure there.");
    if (source.archivedAt !== null)
      yield* threads.dispatch({
        type: "thread.unarchive",
        threadId: source.id,
        commandId: CommandId.make("repair:open:" + first.base),
      });
    const logs = pulls.checkLogs
      ? yield* pulls
          .checkLogs({
            projectId: input.projectId,
            repository: target.repository,
            host: target.host,
            number: target.number,
            tailLines: 12,
          })
          .pipe(Effect.orElseSucceed(() => []))
      : [];
    const checks = target.checks.filter((c) => c.status === "failure" && !c.placeholder);
    const text = [
      "CI failed on " +
        target.url +
        " at " +
        target.evidence.head +
        ". Diagnose and fix the failing checks in this feature chat. Return the fix to the same pull request for review.",
      ...checks.map((c) =>
        [c.name, c.description, c.url].filter(Boolean).join(" · ").slice(0, 1200),
      ),
      ...logs
        .slice(0, 3)
        .map((log) =>
          JSON.stringify({ check: log.name, logTail: log.log?.slice(-1500) ?? log.detail }),
        ),
    ].join("\n");
    // A crash after delivery is safe to retry. The command and message IDs remain stable.
    yield* threads.sendToThread({
      projectId: input.projectId,
      threadId: source.id,
      text,
      attachments: [],
      mode: "queue",
      messageId: repairId,
      commandId: CommandId.make("repair:" + first.base),
      createdBy: "user",
      creationSource: "server",
    });
    yield* sql`UPDATE coordinator_handoffs SET repair_base=${first.base} WHERE message_id=${first.id} AND repair_base IS NULL`;
    return { threadId: source.id };
  }
  if (input.type === "prepare" || input.type === "release") {
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
    const [policy] = yield* sql<{
      instructions: string;
      github_release: number;
    }>`SELECT instructions,github_release FROM coordinator_playbooks WHERE project_id=${input.projectId}`;
    const releasing = input.type === "release";
    if (releasing && !policy?.github_release)
      return yield* error(
        "Configure the protected GitHub release workflow before requesting a production release.",
      );
    if (
      releasing &&
      (!policy?.instructions ||
        items.some((i) => !i.approved || !i.pulls.length || i.pulls.some((p) => !p.evidence?.head)))
    )
      return yield* error(
        "Approve each revision and configure the project release playbook first.",
      );
    if (
      releasing &&
      items.some((i) =>
        i.pulls.some((p) =>
          p.evidence?.criteria?.some(
            (c) =>
              c.check &&
              (!p.evidence?.headChecksComplete ||
                p.evidence?.headChecks?.filter((check) => check.name === c.check).length !== 1 ||
                !p.evidence.headChecks.some(
                  (check) => check.name === c.check && check.status === "success",
                )),
          ),
        ),
      )
    )
      return yield* error(
        "A required acceptance check is missing or has not passed for this revision.",
      );
    const key = revision([
      input.type,
      policy?.instructions ?? "",
      input.projectId,
      items.map((i) => [i.id, i.revision]).sort(),
    ]);
    if (releasing) {
      const links = items.flatMap((i) => i.pulls);
      const ref = links[0]!;
      const branch = ref.evidence?.defaultBranch;
      const candidate = ref.evidence?.defaultRevision;
      if (
        !pulls.dispatchCoordinatorRelease ||
        !branch ||
        !candidate ||
        !/^[a-f0-9]{40}$/i.test(candidate) ||
        project.repositoryIdentity?.canonicalKey.toLowerCase() !==
          ref.host.toLowerCase() + "/" + ref.repository.toLowerCase() ||
        links.some(
          (p) =>
            p.host !== ref.host ||
            p.repository.toLowerCase() !== ref.repository.toLowerCase() ||
            p.evidence?.state !== "MERGED" ||
            p.evidence.defaultRevision !== candidate ||
            !p.evidence.merge,
        )
      )
        return yield* error("Select merged changes including the current default-branch revision.");
      for (const p of links) {
        const merge = p.evidence!.merge!;
        if (
          merge !== candidate &&
          (yield* pulls.coordinatorIncludes({
            projectId: input.projectId,
            ...p,
            base: merge,
            head: candidate,
          })) !== true
        )
          return yield* error(
            "The release candidate could not be verified to contain all selected changes.",
          );
      }
      const requestId = revision([
        input.projectId,
        ref.host,
        ref.repository.toLowerCase(),
        candidate,
      ]);
      const claim = yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* teamAccess(sql, input.projectId, actor);
          if (
            !current.release ||
            !reviewedManifest ||
            matchingHolds(yield* listHolds(sql, input.projectId), reviewedManifest.files, [
              ...links.map((l) => l.number),
              ...reviewedManifest.commits.flatMap((c) => c.pulls),
            ]).length
          )
            return yield* error("Release authorization or project holds changed.");
          const inserted =
            yield* sql`INSERT INTO coordinator_release_requests(request_id,project_id,revision,state) VALUES(${requestId},${input.projectId},${candidate},'dispatching') ON CONFLICT DO NOTHING RETURNING request_id`;
          if (inserted.length)
            yield* audit(
              sql,
              input.projectId,
              "request-release",
              actor,
              reviewedManifest.head + " " + reviewedManifest.token,
            );
          return inserted;
        }),
      );
      if (claim.length) {
        yield* pulls
          .dispatchCoordinatorRelease({
            projectId: input.projectId,
            host: ref.host,
            repository: ref.repository,
            number: ref.number,
            branch,
            revision: candidate,
            requestId,
            pullNumbers: encodeNumbers([...new Set(links.map((p) => p.number))]),
          })
          .pipe(
            Effect.catch((e) =>
              Effect.gen(function* () {
                if (
                  e._tag === "PullRequestUnavailableError" ||
                  (e._tag === "PullRequestOperationError" && e.reason === "not-found")
                ) {
                  yield* sql`DELETE FROM coordinator_release_requests WHERE request_id=${requestId} AND state='dispatching'`;
                  return yield* error(
                    "GitHub could not start putmancode-release.yml. Check installation and workflow access, then retry.",
                  );
                }
                return yield* error(
                  "Workflow delivery could not be confirmed. Check GitHub Actions for request " +
                    requestId +
                    " before retrying.",
                );
              }),
            ),
          );
        yield* sql`UPDATE coordinator_release_requests SET state='accepted' WHERE request_id=${requestId}`;
      } else {
        const [prior] = yield* sql<{
          state: string;
        }>`SELECT state FROM coordinator_release_requests WHERE request_id=${requestId}`;
        if (prior?.state !== "accepted")
          return yield* error(
            "Check the outstanding release request in GitHub Actions: " + requestId,
          );
      }
      yield* sql.withTransaction(
        Effect.forEach(
          items,
          (i) =>
            sql`UPDATE coordinator_handoffs SET released_revision=${i.revision} WHERE message_id=${i.id} AND project_id=${input.projectId}`,
        ),
      );
      return { threadId: first.coordinatorId };
    }
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
      messageId: MessageId.make(input.type + ":" + key),
      commandId: CommandId.make(input.type + ":" + key),
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
    const link = pullLink(input.url);
    if (!link) return yield* error("Enter a GitHub pull request URL.");
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
      ? yield* sql.withTransaction(
          Effect.gen(function* () {
            const now = yield* teamAccess(sql, input.projectId, actor);
            if (!now.approve || !now.named)
              return yield* error(
                "A project administrator must register your name and approval permission first.",
              );
            actor = now.actor;
            const r =
              yield* sql`UPDATE coordinator_handoffs SET approved_revision=${first.revision},approved_by=${actor.label},approved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE message_id=${first.id} AND project_id=${input.projectId} AND assets_json IS ${first.storedAssets} AND additional_pulls_json IS ${first.storedPulls} RETURNING message_id`;
            if (r.length) yield* audit(sql, input.projectId, "approve", actor, first.revision);
            return r;
          }),
        )
      : yield* sql`UPDATE coordinator_handoffs SET assets_json=${encodeAssets({ preview: coordinatorWebUrl(input.assets.preview), before: coordinatorWebUrl(input.assets.before), after: coordinatorWebUrl(input.assets.after) })},assets_revision=${first.base},approved_revision=NULL,prepared_revision=NULL WHERE message_id=${first.id} AND project_id=${input.projectId} AND assets_json IS ${first.storedAssets} AND additional_pulls_json IS ${first.storedPulls} RETURNING message_id`;
  if (!updated.length)
    return yield* error("Another reviewer changed this handoff. Refresh and try again.");
  return { threadId: first.coordinatorId };
}, Effect.mapError(boardError));

export const reconcileCoordinatorQueues = Effect.fn("CoordinatorBoard.reconcile")(function* (
  sql: Sql,
  projects: ProjectsApi,
  threads: ThreadManagementServiceShape,
  pulls: Pulls & Pick<PullRequestService["Service"], "list">,
) {
  const policies = yield* sql<{
    project_id: string;
    auto_repair: number;
  }>`SELECT project_id,auto_repair FROM coordinator_playbooks`;
  for (const policy of policies) {
    const projectId = ProjectId.make(policy.project_id);
    yield* Effect.gen(function* () {
      const active = Option.getOrNull(yield* projects.getById(projectId));
      if (!active || active.archivedAt || active.deletedAt) return;
      let cursors: import("@t3tools/contracts").PullRequestListCursors | undefined;
      do {
        const page = yield* pulls
          .list({
            projectId,
            state: "open",
            involvement: "all",
            filters: { labels: [["coordinator"]] },
            limit: 100,
            ...(cursors ? { cursors } : {}),
          })
          .pipe(
            Effect.catch((e) =>
              Effect.logDebug("Coordinator PR list unavailable", e._tag).pipe(Effect.as(null)),
            ),
          );
        if (!page) break;
        for (const pr of page.entries) {
          if (
            pr.projectId !== projectId ||
            !pr.labels.some((l) => l.name.toLowerCase() === "coordinator")
          )
            continue;
          const link = pullLink(pr.url);
          if (!link) continue;
          const id = MessageId.make(
            "queue-pr:" + revision([projectId, link.host, link.repository, link.number]),
          );
          const exists =
            yield* sql`SELECT 1 FROM coordinator_handoffs WHERE message_id=${id} AND delivered=1`;
          if (!exists.length)
            yield* submitCoordinatorPull(projectId, pr.url, sql, projects, threads, pulls).pipe(
              Effect.catch((e) => Effect.logDebug("Coordinator PR intake failed", e._tag)),
            );
        }
        cursors = page.nextCursors;
      } while (Object.keys(cursors).length);
      if (!policy.auto_repair) return;
      const items = yield* loadItems(projectId, sql, threads, pulls);
      const newest = new Set<ThreadId>();
      for (const item of items) {
        if (item.external || newest.has(item.threadId)) continue;
        newest.add(item.threadId);
        if (
          item.phase !== "failed" ||
          item.repairState ||
          !item.pulls.some((p) => p.evidence?.ciDiagnosis?.kind === "pr")
        )
          continue;
        yield* actOnCoordinatorBoard(
          { type: "repair", projectId, item: { id: item.id, revision: item.revision } },
          sql,
          projects,
          threads,
          pulls,
          workerActor,
        ).pipe(Effect.ignore);
      }
    }).pipe(Effect.catch((e) => Effect.logDebug("Coordinator queue refresh failed", e._tag)));
  }
});

export function boardQuestion(text: string) {
  const q = text
    .trim()
    .toLowerCase()
    .replace(/[?!.\s]+$/u, "")
    .replace(/what['’]s/g, "what is");
  if (["what is live", "what is deployed", "what is in production"].includes(q))
    return "production";
  if (
    [
      "did ci pass",
      "is ci green",
      "did the tests pass",
      "ci status",
      "what is the ci status",
    ].includes(q)
  )
    return "ci";
  return null;
}

/** Direct factual answers never infer a successful check or deployment from a conversation. */
export const answerBoardQuestion = Effect.fn("CoordinatorBoard.answer")(function* (
  kind: "ci" | "production",
  projectId: ProjectId,
  sql: Sql,
  pulls: Pick<Pulls, "coordinatorChange" | "coordinatorProduction">,
) {
  if (kind === "production") {
    const history = yield* pulls.coordinatorProduction(projectId);
    const success = history?.find((d) => d.state === "SUCCESS");
    const latest = history?.[0];
    const answer = success
      ? "Last verified production deployment: " +
        success.repository +
        " at " +
        success.revision +
        " (" +
        success.at +
        ")." +
        (success.url ? "\n" + success.url : "")
      : history
        ? "No successful production deployment is recorded."
        : "Production deployment status is unavailable.";
    return (
      answer +
      (latest && latest !== success
        ? "\nLatest deployment attempt: " + latest.revision + " · " + latest.state
        : "")
    );
  }
  const rows = yield* rowsFor(sql, projectId);
  const refs = new Map<string, typeof pullSchema.Type>();
  for (const row of rows) {
    const snapshot = row.snapshot_json ? yield* decodeSnapshot(row.snapshot_json) : null;
    const additional = row.additional_pulls_json
      ? yield* decodePulls(row.additional_pulls_json)
      : [];
    const legacy = snapshot
      ? []
      : (row.text?.match(/^Pull request: https:\/\/\S+/gm) ?? []).flatMap(
          (line) => pullLink(line.slice("Pull request: ".length)) ?? [],
        );
    for (const link of [...(snapshot?.pulls ?? legacy), ...additional])
      refs.set(link.host + "/" + link.repository.toLowerCase() + "#" + link.number, link);
  }
  if (!refs.size) return "There are no pull requests linked to the coordinator queue.";
  const checks = yield* Effect.forEach(
    refs.values(),
    (link) =>
      pulls
        .coordinatorChange({ projectId, ...link })
        .pipe(
          Effect.map((e) =>
            e?.state === "CLOSED" || e?.state === "MERGED"
              ? null
              : link.repository +
                " #" +
                link.number +
                " · " +
                (e?.checks ?? "checks unavailable") +
                (e?.head ? " · " + e.head.slice(0, 8) : ""),
          ),
        ),
    { concurrency: 3 },
  );
  return checks.some(Boolean)
    ? checks.filter(Boolean).join("\n")
    : "There are no open pull requests in the coordinator queue.";
});

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

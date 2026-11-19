import {
  ProjectCoordinatorError,
  ThreadId,
  summarizeCoordinatorStatuses,
  type CoordinatorStatus,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type PullRequestRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";

const decodeHandoff = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([ThreadId, ThreadId, Schema.String])),
);

function linkedPulls(shell: OrchestrationV2ThreadShell, since?: string): PullRequestRef[] {
  const refs: PullRequestRef[] = [];
  for (const link of shell.pullRequests ?? []) {
    if (
      link.source === "stack-dismissed" ||
      (since && Date.parse(link.linkedAt) < Date.parse(since))
    )
      continue;
    refs.push({
      projectId: shell.projectId,
      host: link.host,
      repository: link.repository,
      number: link.number,
    });
  }
  if (!since) {
    const primary = shell.linkedPullRequest ?? shell.branchPullRequest;
    if (
      primary &&
      !refs.some((ref) => ref.repository === primary.repository && ref.number === primary.number)
    ) {
      refs.push({
        projectId: shell.projectId,
        repository: primary.repository,
        number: primary.number,
      });
    }
  }
  return refs;
}

/** Read the current coordinator slot without creating or unarchiving a thread. */
export const readCoordinatorStatus = Effect.fn("ProjectCoordinator.status")(
  function* (
    projectId: ProjectId,
    sql: SqlClient.SqlClient,
    threads: Pick<ThreadManagementServiceShape, "getThreadShell">,
    readPull: (ref: PullRequestRef) => Effect.Effect<CoordinatorStatus>,
  ) {
    const prefix = `coordinator-${encodeURIComponent(projectId)}-`;
    const [active] = yield* sql<{ thread_id: string }>`
    SELECT thread_id FROM orchestration_v2_projection_threads
    WHERE project_id = ${projectId} AND deleted_at IS NULL
      AND thread_id = ${prefix} || CAST(CAST(substr(thread_id, ${prefix.length + 1}) AS INTEGER) AS TEXT)
    ORDER BY CAST(substr(thread_id, ${prefix.length + 1}) AS INTEGER) DESC LIMIT 1`;
    if (!active) return "idle" as const;
    const coordinator = yield* threads.getThreadShell(ThreadId.make(active.thread_id));
    if (!coordinator) return "idle" as const;
    if (coordinator.pendingRuntimeRequest || coordinator.hasActionableProposedPlan)
      return "review" as const;
    const [handoff] = yield* sql<{ message_id: string; created_at: string }>`
    SELECT message_id, created_at FROM orchestration_v2_projection_messages
    WHERE thread_id = ${coordinator.id} AND role = 'user' AND message_id GLOB 'handoff:*'
    ORDER BY created_at DESC, rowid DESC LIMIT 1`;
    let refs = linkedPulls(coordinator, handoff?.created_at);
    if (handoff) {
      const key = Option.getOrNull(decodeHandoff(handoff.message_id.slice("handoff:".length)));
      if (key?.[0] === coordinator.id) {
        const source = yield* threads.getThreadShell(key[1]);
        if (source?.projectId === projectId) refs = [...linkedPulls(source), ...refs];
      }
    }
    if (refs.length === 0) return handoff ? ("review" as const) : ("idle" as const);
    const unique = new Map(
      refs.map((ref) => [
        JSON.stringify([ref.host, ref.repository.toLowerCase(), ref.number]),
        ref,
      ]),
    );
    return summarizeCoordinatorStatuses(
      yield* Effect.forEach(unique.values(), readPull, { concurrency: 3 }),
    );
  },
  Effect.mapError(
    () => new ProjectCoordinatorError({ message: "Could not read coordinator status." }),
  ),
);

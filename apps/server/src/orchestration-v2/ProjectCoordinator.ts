import {
  CommandId,
  MessageId,
  ProjectCoordinatorError,
  ThreadId,
  isListedThreadLineage,
  isOrchestrationV2WorkActive,
  isProjectCoordinatorThread,
  type ModelSelection,
  type ServerProvider,
  type OrchestrationV2RpcSchemas,
  type Project,
  type RunId,
  type VcsStatusLocalResult,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Projects from "../project/ProjectService.ts";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";
import { initialCoordinatorModel } from "./coordinatorRouting.ts";
import { canHandOffRun, unfinishedHandoffRunStatuses } from "./projectCoordinatorState.ts";

type Input = typeof OrchestrationV2RpcSchemas.projectCoordinator.input.Type;
type ReadCatalog = (id: ModelSelection["instanceId"]) => Effect.Effect<ServerProvider | undefined>;
type ReadCheckout = (
  cwd: string,
) => Effect.Effect<Pick<
  VcsStatusLocalResult,
  "isRepo" | "refName" | "hasWorkingTreeChanges"
> | null>;
const isProjectCoordinatorError = Schema.is(ProjectCoordinatorError);
const encodeHandoffKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const fail = (message: string) => new ProjectCoordinatorError({ message });

const ensureCoordinator = Effect.fn("ProjectCoordinator.ensure")(function* (
  threads: ThreadManagementServiceShape,
  project: Project,
  model: ModelSelection,
  readCatalog: ReadCatalog,
) {
  // A deleted coordinator keeps its identity and history. Its successor gets the next slot.
  for (let slot = 0; ; slot++) {
    const id = ThreadId.make(`coordinator-${encodeURIComponent(project.id)}-${slot}`);
    const createId = CommandId.make(`coordinator:create:${id}`);
    let thread = yield* threads.getThreadShell(id);
    if (thread === null) {
      yield* threads.dispatch({
        type: "thread.create",
        threadId: id,
        projectId: project.id,
        title: "Coordinator",
        commandId: createId,
        createdBy: "user",
        creationSource: "web",
        modelSelection:
          project.defaultModelSelection ??
          initialCoordinatorModel(
            yield* readCatalog(model.instanceId),
            model,
            project.workspaceRoot,
          ),
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      thread = yield* threads.getThreadShell(id);
      if (thread === null) continue;
    }
    if (thread.projectId !== project.id)
      return yield* fail("The coordinator belongs to another project.");
    if (thread.archivedAt !== null) {
      yield* threads.dispatch({
        type: "thread.unarchive",
        threadId: id,
        commandId: CommandId.make(
          `coordinator:restore:${id}:${DateTime.toEpochMillis(thread.archivedAt)}`,
        ),
      });
    }
    if (!thread.pinnedAt) {
      yield* threads.dispatch({
        type: "thread.pin",
        threadId: id,
        commandId: CommandId.make(
          `coordinator:pin:${id}:${DateTime.toEpochMillis(thread.updatedAt)}`,
        ),
      });
    }
    return id;
  }
});

const handoff = Effect.fn("ProjectCoordinator.handoff")(function* (
  input: { readonly threadId: ThreadId; readonly runId: RunId },
  threads: ThreadManagementServiceShape,
  project: Project,
  readCheckout: ReadCheckout,
  readCatalog: ReadCatalog,
) {
  const source = yield* threads.getThreadShell(input.threadId);
  if (
    !source ||
    source.projectId !== project.id ||
    !isListedThreadLineage(source.lineage) ||
    isProjectCoordinatorThread(project.id, source.id)
  ) {
    return yield* fail("Choose a feature chat in this project.");
  }
  if (!canHandOffRun(source, input.runId) && source.archivedAt === null) {
    return yield* fail("Finish the current feature turn before sending it to the coordinator.");
  }
  const targetId = yield* ensureCoordinator(threads, project, source.modelSelection, readCatalog);
  const key = encodeHandoffKey([targetId, source.id, input.runId]);
  const messageId = MessageId.make(`handoff:${key}`);
  const archive = threads.dispatch({
    type: "thread.archive",
    threadId: source.id,
    handoffRunId: input.runId,
    commandId: CommandId.make(`archive:${key}:${DateTime.toEpochMillis(source.updatedAt)}`),
  });
  const delivered = yield* threads.getProjectThreadRecords(
    { projectId: project.id, threadId: targetId },
    ["messages"],
    { messageIds: [messageId] },
  );
  if (delivered.messages.length > 0) {
    if (source.archivedAt === null) yield* archive;
    return targetId;
  }
  if (source.archivedAt !== null) return yield* fail("This feature chat was archived separately.");
  const records = yield* threads.getProjectThreadRecords(
    { projectId: project.id, threadId: source.id },
    ["messages", "checkpoints", "subagents", "runs", "turnItems"],
    {
      messageRunIds: [input.runId],
      runStatuses: unfinishedHandoffRunStatuses,
      turnItemRunIds: [input.runId],
      turnItemTypes: ["command_execution"],
    },
  );
  if (records.runs.length > 0) return yield* fail("This feature chat has unfinished turns.");
  if (
    records.subagents.some(
      (task) =>
        task.origin === "app_owned" &&
        task.childThreadId &&
        isOrchestrationV2WorkActive(task.status),
    )
  ) {
    return yield* fail("A delegated task is still working in this feature chat.");
  }
  const request = records.messages.findLast((m) => m.role === "user")?.text;
  const result = records.messages.findLast((m) => m.role === "assistant" && !m.streaming)?.text;
  const checkpoint = records.checkpoints.findLast(
    (cp) => cp.runId === input.runId && cp.status === "ready",
  );
  const sourceLink = formatThreadLink({ environmentId: null, threadId: source.id }, source.title);
  const workspace = source.worktreePath ?? project.workspaceRoot;
  const checkout = yield* readCheckout(workspace);
  const scriptResults = new Map<string, string>();
  for (const item of records.turnItems) {
    if (item.type !== "command_execution") continue;
    // Only attribute an exit code when the recorded command matches the configured script.
    const script = project.scripts.find((entry) => entry.command.trim() === item.input.trim());
    if (script)
      scriptResults.set(
        script.name,
        item.exitCode === undefined ? item.status : `exit ${item.exitCode}`,
      );
  }
  const pulls = (source.pullRequests ?? []).filter((link) => link.source !== "stack-dismissed");
  const primaryPull = source.linkedPullRequest ?? source.branchPullRequest;
  const text = [
    `Feature handoff from ${sourceLink}`,
    `Workspace: ${workspace}`,
    `Feature branch: ${source.branch ?? "(project checkout)"}`,
    checkout?.isRepo
      ? `Checkout at handoff: ${checkout.refName ?? "(detached HEAD)"}; ${checkout.hasWorkingTreeChanges ? "uncommitted changes" : "clean working tree"}`
      : "Checkout status unavailable.",
    `Feature run: ${input.runId}`,
    ...(checkpoint
      ? [
          `Checkpoint: ${checkpoint.ref}`,
          ...checkpoint.files
            .slice(0, 40)
            .map((file) => `  ${file.path} (+${file.additions} / -${file.deletions})`),
        ]
      : []),
    ...pulls.flatMap((link) => [
      `Pull request: ${link.url}`,
      ...(link.snapshot
        ? [
            `Last synced ${link.snapshot.syncedAt}: ${link.snapshot.headBranch} → ${link.snapshot.baseBranch}; ${link.snapshot.state}; checks ${link.snapshot.checksState ?? "unknown"}`,
          ]
        : []),
    ]),
    ...(primaryPull && !pulls.some((link) => link.url === primaryPull.url)
      ? [`Pull request: ${primaryPull.url}`]
      : []),
    ...(!pulls.length && !primaryPull ? ["No linked pull request."] : []),
    "Recorded project scripts for this turn:",
    ...(scriptResults.size
      ? Array.from(scriptResults, ([name, status]) => `  ${name}: ${status}`)
      : ["  No matching script results recorded."]),
    ...(request ? ["", "Feature request:", request.slice(0, 2000)] : []),
    ...(result ? ["", "Feature chat result:", result.slice(0, 6000)] : []),
    "",
    "Coordinator next steps: inspect the feature checkout and the linked conversation, verify the intended changes and run the repository’s checks. Refresh CI for the exact PR head before merging. Follow this project’s release workflow and approvals, and report the deployed revision and site verification when available.",
  ].join("\n");
  yield* threads.sendToThread({
    projectId: project.id,
    threadId: targetId,
    commandId: CommandId.make(`deliver:${key}`),
    messageId,
    text,
    attachments: [],
    mode: "queue",
    createdBy: "user",
    creationSource: "web",
  });
  yield* archive;
  return targetId;
});

export const runProjectCoordinator = Effect.fn("ProjectCoordinator.run")(
  function* (
    input: Input,
    projects: Pick<Projects.ProjectService["Service"], "getById">,
    threads: ThreadManagementServiceShape,
    readCheckout: ReadCheckout,
    readCatalog: ReadCatalog = () => Effect.undefined,
  ) {
    const project = Option.getOrNull(yield* projects.getById(input.projectId));
    if (!project || project.archivedAt) return yield* fail("Choose an active project.");
    const threadId =
      input.action === "open"
        ? yield* ensureCoordinator(threads, project, input.modelSelection, readCatalog)
        : yield* handoff(input, threads, project, readCheckout, readCatalog);
    return { threadId };
  },
  Effect.mapError((error) =>
    isProjectCoordinatorError(error)
      ? error
      : fail(
          error instanceof Error ? error.message : "The coordinator could not accept this handoff.",
        ),
  ),
);

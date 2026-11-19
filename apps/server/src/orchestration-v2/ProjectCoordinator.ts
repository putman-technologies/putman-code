import {
  CommandId,
  MessageId,
  ProjectCoordinatorError,
  ThreadId,
  isListedThreadLineage,
  isOrchestrationV2WorkActive,
  type ModelSelection,
  type OrchestrationV2RpcSchemas,
  type Project,
  type RunId,
} from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Projects from "../project/ProjectService.ts";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";
import { canHandOffRun, unfinishedHandoffRunStatuses } from "./projectCoordinatorState.ts";

type Input = typeof OrchestrationV2RpcSchemas.projectCoordinator.input.Type;
const isProjectCoordinatorError = Schema.is(ProjectCoordinatorError);
const encodeHandoffKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const fail = (message: string) => new ProjectCoordinatorError({ message });

const ensureCoordinator = Effect.fn("ProjectCoordinator.ensure")(function* (
  threads: ThreadManagementServiceShape,
  project: Project,
  model: ModelSelection,
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
        modelSelection: project.defaultModelSelection ?? model,
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
) {
  const source = yield* threads.getThreadShell(input.threadId);
  if (
    !source ||
    source.projectId !== project.id ||
    !isListedThreadLineage(source.lineage) ||
    source.id.startsWith(`coordinator-${encodeURIComponent(project.id)}-`)
  ) {
    return yield* fail("Choose a feature chat in this project.");
  }
  if (!canHandOffRun(source, input.runId) && source.archivedAt === null) {
    return yield* fail("Finish the current feature turn before sending it to the coordinator.");
  }
  const targetId = yield* ensureCoordinator(threads, project, source.modelSelection);
  const key = encodeHandoffKey([targetId, source.id, input.runId]);
  const messageId = MessageId.make(`handoff:${key}`);
  if (source.archivedAt !== null) {
    const saved = yield* threads.getProjectThreadRecords(
      { projectId: project.id, threadId: targetId },
      ["messages"],
      { messageIds: [messageId] },
    );
    if (!saved.messages.length) return yield* fail("This feature chat was archived separately.");
    return targetId;
  }
  const records = yield* threads.getProjectThreadRecords(
    { projectId: project.id, threadId: source.id },
    ["messages", "checkpoints", "subagents", "runs"],
    { messageRunIds: [input.runId], runStatuses: unfinishedHandoffRunStatuses },
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
  const text = [
    `Feature handoff from ${sourceLink}`,
    `Workspace: ${source.worktreePath ?? project.workspaceRoot}`,
    `Branch: ${source.branch ?? "(project checkout)"}`,
    `Feature run: ${input.runId}`,
    ...(checkpoint
      ? [
          `Checkpoint: ${checkpoint.ref}`,
          ...checkpoint.files
            .slice(0, 40)
            .map((file) => `  ${file.path} (+${file.additions} / -${file.deletions})`),
        ]
      : []),
    ...(source.linkedPullRequest ? [`Pull request: ${source.linkedPullRequest.url}`] : []),
    ...(request ? ["", "Feature request:", request.slice(0, 2000)] : []),
    ...(result ? ["", "Feature chat result:", result.slice(0, 6000)] : []),
    "",
    "The full conversation and test output are available in the linked feature chat.",
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
  yield* threads.dispatch({
    type: "thread.archive",
    threadId: source.id,
    handoffRunId: input.runId,
    commandId: CommandId.make(`archive:${key}:${DateTime.toEpochMillis(source.updatedAt)}`),
  });
  return targetId;
});

export const runProjectCoordinator = Effect.fn("ProjectCoordinator.run")(
  function* (
    input: Input,
    projects: Pick<Projects.ProjectService["Service"], "getById">,
    threads: ThreadManagementServiceShape,
  ) {
    const project = Option.getOrNull(yield* projects.getById(input.projectId));
    if (!project || project.archivedAt) return yield* fail("Choose an active project.");
    const threadId =
      input.action === "open"
        ? yield* ensureCoordinator(threads, project, input.modelSelection)
        : yield* handoff(input, threads, project);
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

import {
  isProviderAvailable,
  type ModelSelection,
  type OrchestrationV2Command,
  type ProjectId,
  type ServerProvider,
  isProjectCoordinatorThread,
} from "@t3tools/contracts";

type Send = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;

const simpleQuestions = new Set([
  "hi",
  "hey",
  "hello",
  "thanks",
  "thank you",
  "good morning",
  "good evening",
  "status",
  "status update",
  "any updates",
  "how is it going",
  "how is the project going",
  "where are we",
  "where do we stand",
  "what needs review",
  "what is still open",
  "what is open",
  "what is pending",
  "what is left",
  "what is still pending",
  "what is still left",
]);

const routineQuestions = [
  /^(?:what is (?:the |our )?(?:(?:project|ci|build|deployment|release) )?status|status(?: update)?)(?: (?:on|for|of) (?:pr|pull request) #?\d+)?$/,
  /^(?:list|show)(?: me)? (?:the |our )?(?:open prs|open pull requests|working chats|pending handoffs|pending tasks|open tasks)$/,
  /^(?:summari[sz]e|recap)(?: (?:this (?:chat|thread|project)|the (?:current status|last (?:turn|handoff)|progress so far)|our progress))?$/,
  /^(?:did (?:ci|the (?:build|tests|deployment)) (?:pass|finish|succeed)|is (?:ci|the build) (?:green|passing))$/,
];

export function isRoutineCoordinatorMessage(projectId: ProjectId, command: Send): boolean {
  if (
    !isProjectCoordinatorThread(projectId, command.threadId) ||
    command.createdBy !== "user" ||
    (command.creationSource !== "web" && command.creationSource !== "mobile") ||
    command.attachments.length ||
    command.context?.records.length ||
    command.context?.guest ||
    command.sourcePlanRef ||
    command.notification ||
    command.guestMessageId ||
    command.senderThreadId ||
    command.scheduledTaskId ||
    command.linkedSender ||
    command.delegatedCompletion ||
    command.restartContinuationOfRunId ||
    command.manualContinuationOfRunId ||
    command.usageLimitContinuationOfRunId ||
    command.steerFollowUpOfRunId ||
    command.freshContext ||
    command.text.length > 140
  )
    return false;
  const text = command.text
    .trim()
    .toLowerCase()
    .replace(/^(what|how)['’]s\b/u, "$1 is")
    .replace(/[?!.]+$/u, "");
  return simpleQuestions.has(text) || routineQuestions.some((pattern) => pattern.test(text));
}

function usableCatalog(
  snapshot: ServerProvider | undefined,
  work: ModelSelection,
): snapshot is ServerProvider {
  return (
    snapshot !== undefined &&
    snapshot.instanceId === work.instanceId &&
    snapshot.enabled &&
    snapshot.installed &&
    snapshot.compatibilityAdvisory?.status !== "broken" &&
    snapshot.compatibilityAdvisory?.status !== "unsupported" &&
    snapshot.status !== "error" &&
    snapshot.status !== "disabled" &&
    isProviderAvailable(snapshot) &&
    snapshot.auth.status !== "unauthenticated"
  );
}

// Some providers advertise different model lists for individual checkouts.
function availableModels(snapshot: ServerProvider, cwd?: string | null) {
  const workspaces = snapshot.workspaceSnapshots ?? [];
  const workspace = workspaces.find((entry) => entry.cwd === cwd);
  const available = (model: ServerProvider["models"][number]) =>
    !model.isLegacy &&
    !model.isCustom &&
    !snapshot.subProviders?.some((sub) => sub.name === model.subProvider && sub.unavailableReason);
  return (workspace?.models ?? snapshot.models).filter(
    (model) =>
      available(model) &&
      (cwd != null ||
        workspaces.every(
          (entry) =>
            !entry.models ||
            entry.models.some((candidate) => candidate.slug === model.slug && available(candidate)),
        )),
  );
}

export function initialCoordinatorModel(
  snapshot: ServerProvider | undefined,
  base: ModelSelection,
  cwd?: string | null,
): ModelSelection {
  if (!usableCatalog(snapshot, base)) return base;
  const prefix = base.model.includes("/") ? base.model.slice(0, base.model.indexOf("/") + 1) : "";
  const family = base.model.slice(prefix.length);
  const candidates = family.startsWith("gpt-")
    ? ["gpt-6.2-astra", "gpt-6.2", "gpt-6.2-sol"]
    : family.startsWith("claude-")
      ? ["claude-fable-5-1", "claude-fable-5.1", "claude-fable-5"]
      : [];
  const models = availableModels(snapshot, cwd);
  const model = candidates
    .map((slug) => prefix + slug)
    .find((slug) => models.some((entry) => entry.slug === slug));
  return model && model !== base.model ? { instanceId: base.instanceId, model } : base;
}

export function coordinatorQuickModel(
  snapshot: ServerProvider | undefined,
  work: ModelSelection,
  cwd?: string | null,
): ModelSelection | undefined {
  if (!usableCatalog(snapshot, work)) return undefined;
  const [vendor, slug] = work.model.includes("/") ? work.model.split("/") : ["", work.model];
  if (!slug) return undefined;
  // Use a recognized smaller sibling of the work model on the same connected provider.
  const family =
    (!vendor || vendor === "openai") &&
    /^gpt-\d+(?:\.\d+)?(?:-(?:astra|sol|pro|codex))?(?:-\d{4}-\d{2}-\d{2})?$/i.test(slug)
      ? /^gpt-\d+(?:\.\d+)?-(?:luna|mini)(?:-\d{4}-\d{2}-\d{2})?$/i
      : (!vendor || vendor === "anthropic") && /^claude-(?:fable|opus|sonnet)-/i.test(slug)
        ? /^claude-haiku-\d+(?:[.-]\d+)*$/i
        : undefined;
  if (!family) return undefined;
  const prefix = vendor ? vendor + "/" : "";
  const candidate = availableModels(snapshot, cwd).find(
    ({ slug }) => slug.startsWith(prefix) && family.test(slug.slice(prefix.length)),
  );
  return candidate ? { instanceId: work.instanceId, model: candidate.slug } : undefined;
}

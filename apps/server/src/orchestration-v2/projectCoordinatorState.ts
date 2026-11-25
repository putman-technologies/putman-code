import type { OrchestrationV2ThreadShell, RunId } from "@t3tools/contracts";

export const unfinishedHandoffRunStatuses = [
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
] as const;

type SourceState = Pick<
  OrchestrationV2ThreadShell,
  | "latestRunId"
  | "activeRunId"
  | "status"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "pendingGuestMessageCount"
>;

export function canHandOffRun(source: SourceState | null, runId: RunId): boolean {
  return (
    source !== null &&
    source.latestRunId === runId &&
    source.status === "completed" &&
    source.activeRunId === null &&
    source.pendingRuntimeRequest === null &&
    (source.pendingBackgroundTasks?.length ?? 0) === 0 &&
    (source.pendingGuestMessageCount ?? 0) === 0
  );
}

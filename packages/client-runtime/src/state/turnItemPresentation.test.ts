import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  turnItemIsWorkspacePreparation,
  workspacePreparationRetryRunIds,
} from "./turnItemPresentation.ts";

function turnItemBase() {
  const now = DateTime.makeUnsafe("2026-08-03T00:00:00.000Z");
  return {
    id: TurnItemId.make("item-command"),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "Workspace ready",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  } as const;
}

function preparationFailure(
  status: OrchestrationV2TurnItem["status"],
  code: string | null = ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
): OrchestrationV2TurnItem {
  return {
    ...turnItemBase(),
    id: TurnItemId.make("item-error"),
    status,
    title: "Workspace preparation failed",
    type: "error",
    failure: { class: "validation_error", message: "fetch failed", code, retryable: false },
  };
}

const worktree = { type: "worktree", baseRef: "main" } as const;
function run(
  status: OrchestrationV2Run["status"],
  workspacePreparation?: typeof worktree,
): Pick<OrchestrationV2Run, "id" | "status" | "workspacePreparation"> {
  return {
    id: RunId.make("run-1"),
    status,
    ...(workspacePreparation === undefined ? {} : { workspacePreparation }),
  };
}

describe("turnItemIsWorkspacePreparation", () => {
  it("keeps an automatic branch naming timeout out of chat, including on older SSH servers", () => {
    const notice = {
      ...turnItemBase(),
      type: "system_notice",
      id: TurnItemId.make("turn-item:run:run-1:signal:branch-rename"),
      status: "completed",
      title: "Branch not renamed",
      message:
        "Could not rename the worktree branch, so it stays t3/5bf07e5f. Git command failed in GitVcsDriver.renameBranch (/repo): Git command timed out.",
    } as const;
    expect(turnItemIsWorkspacePreparation(notice)).toBe(true);
    expect(
      turnItemIsWorkspacePreparation({ ...notice, title: "Worktree branch rename unconfirmed" }),
    ).toBe(true);
    expect(turnItemIsWorkspacePreparation({ ...notice, message: "Branch is locked." })).toBe(false);
    expect(turnItemIsWorkspacePreparation({ ...notice, title: "Check branch settings" })).toBe(
      false,
    );
    expect(turnItemIsWorkspacePreparation({ ...notice, id: TurnItemId.make("other-notice") })).toBe(
      false,
    );
  });

  it("hides a preparation failure only once a retry cancelled it", () => {
    expect(turnItemIsWorkspacePreparation(preparationFailure("failed"))).toBe(false);
    expect(turnItemIsWorkspacePreparation(preparationFailure("cancelled"))).toBe(true);
    expect(turnItemIsWorkspacePreparation(preparationFailure("cancelled", null))).toBe(false);
  });
});

describe("workspacePreparationRetryRunIds", () => {
  it("offers a retry while the run still ends in its failed preparation", () => {
    const failure = [preparationFailure("failed")];
    expect([...workspacePreparationRetryRunIds([run("failed", worktree)], failure)]).toEqual([
      RunId.make("run-1"),
    ]);
    expect(workspacePreparationRetryRunIds([run("preparing", worktree)], failure).size).toBe(0);
    expect(workspacePreparationRetryRunIds([run("failed")], failure).size).toBe(0);
    expect(
      workspacePreparationRetryRunIds(
        [run("failed", worktree)],
        [preparationFailure("failed", "provider_crashed")],
      ).size,
    ).toBe(0);
  });
});

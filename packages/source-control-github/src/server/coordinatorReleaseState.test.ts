import { describe, expect, it } from "vite-plus/test";
import { summarizeCoordinatorStatuses } from "@t3tools/contracts";
import { coordinatorReleaseState } from "./coordinatorReleaseState.ts";

const open = {
  state: "OPEN",
  reviewDecision: null,
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
  mergeCommit: null,
} as const;
const merged = {
  ...open,
  state: "MERGED",
  mergeCommit: {
    oid: "a".repeat(40),
    statusCheckRollup: { state: "SUCCESS" },
    deployments: { nodes: [] },
  },
} as const;

describe("coordinator release evidence", () => {
  it("uses pending checks on the open PR and gives a requested change priority", () => {
    expect(coordinatorReleaseState(open)).toBe("ci");
    expect(coordinatorReleaseState({ ...open, reviewDecision: "CHANGES_REQUESTED" })).toBe(
      "review",
    );
    expect(coordinatorReleaseState({ ...open, commits: { nodes: [] } })).toBe("review");
    expect(coordinatorReleaseState(null)).toBe("unavailable");
  });
  it("requires the latest production deployment on the merge commit to succeed", () => {
    expect(coordinatorReleaseState(merged)).toBe("awaiting");
    expect(coordinatorReleaseState(merged, true)).toBe("deployed");
    for (const [state, expected] of [
      ["SUCCESS", "unavailable"],
      ["FAILURE", "review"],
      ["QUEUED", "awaiting"],
      ["INACTIVE", "awaiting"],
    ] as const) {
      expect(
        coordinatorReleaseState({
          ...merged,
          mergeCommit: {
            ...merged.mergeCommit,
            deployments: { nodes: [{ latestStatus: { state } }] },
          },
        }),
      ).toBe(expected);
    }
    expect(
      coordinatorReleaseState({
        ...merged,
        mergeCommit: { ...merged.mergeCommit, statusCheckRollup: { state: "PENDING" } },
      }),
    ).toBe("ci");
  });
  it("keeps outstanding work visible across related pull requests and checkouts", () => {
    expect(summarizeCoordinatorStatuses(["deployed", "ci"])).toBe("ci");
    expect(summarizeCoordinatorStatuses(["deployed", "review", "ci"])).toBe("review");
    expect(summarizeCoordinatorStatuses(["idle", "deployed"])).toBe("deployed");
    expect(summarizeCoordinatorStatuses(["deployed", "unavailable"])).toBe("unavailable");
  });
});

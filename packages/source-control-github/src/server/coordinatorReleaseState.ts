import type { CoordinatorStatus } from "@t3tools/contracts";
import type { CoordinatorRelease } from "./pullRequestBatches.graphql.ts";

type Pull = NonNullable<CoordinatorRelease.Result["repository"]>["pullRequest"];

export function coordinatorReleaseState(
  pull: Pull | undefined,
  live: boolean | null = null,
): CoordinatorStatus {
  if (!pull) return "unavailable";
  if (pull.state === "MERGED") {
    const commit = pull.mergeCommit;
    const deployment = commit?.deployments?.nodes?.[0]?.latestStatus?.state;
    if (live === true) return "deployed";
    if (deployment === "SUCCESS" && live === null) return "unavailable";
    if (deployment === "ERROR" || deployment === "FAILURE") return "review";
    const checks = commit?.statusCheckRollup?.state;
    if (checks === "FAILURE" || checks === "ERROR") return "review";
    return checks === "PENDING" ? "ci" : "awaiting";
  }
  if (pull.state === "CLOSED" || pull.reviewDecision === "CHANGES_REQUESTED") return "review";
  const checks = pull.commits.nodes?.[0]?.commit.statusCheckRollup?.state;
  return checks === "PENDING" ? "ci" : "review";
}

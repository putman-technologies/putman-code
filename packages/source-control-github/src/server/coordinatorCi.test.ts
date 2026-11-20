import { describe, expect, it } from "vite-plus/test";
import { diagnoseCi } from "./coordinatorCi.ts";
const suite = (outcomes: string[], truncated = false) => ({
  pageInfo: { hasNextPage: truncated },
  nodes: outcomes.map((conclusion) => ({
    __typename: "CheckRun",
    name: "Build",
    conclusion,
    checkSuite: { app: { slug: "ci" } },
  })),
});
describe("coordinator CI diagnosis", () => {
  it.each([
    ["SUCCESS", "pr"],
    ["FAILURE", "baseline"],
    ["IN_PROGRESS", "unknown"],
  ])("compares matching checks with base %s", (base, kind) => {
    expect(diagnoseCi(suite(["FAILURE"]), suite([base!]), "base")?.kind).toBe(kind);
  });
  it("distinguishes startup failures and ambiguous or incomplete evidence", () => {
    expect(diagnoseCi(suite(["STARTUP_FAILURE"]), null, null)?.kind).toBe("runner");
    expect(diagnoseCi(suite(["FAILURE"]), suite(["SUCCESS", "SUCCESS"]), "base")?.kind).toBe(
      "unknown",
    );
    expect(diagnoseCi(suite(["FAILURE"], true), suite(["SUCCESS"]), "base")?.kind).toBe("unknown");
    expect(diagnoseCi(suite(["FAILURE"]), null, null)?.kind).toBe("unknown");
    expect(diagnoseCi(suite(["SUCCESS"]), null, null)).toBeUndefined();
  });
});

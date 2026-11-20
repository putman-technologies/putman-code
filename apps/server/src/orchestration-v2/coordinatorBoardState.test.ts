import { describe, it, expect } from "vite-plus/test";
import { ThreadId, type CoordinatorChange } from "@t3tools/contracts";
import { emptyAssets, findFileOverlaps, releasePhase } from "./coordinatorBoardState.ts";

const green: CoordinatorChange = {
  state: "OPEN",
  head: "one",
  merge: null,
  checks: "SUCCESS",
  draft: false,
  changesRequested: false,
  conflict: false,
  preview: null,
  before: null,
  after: null,
  deployedAt: null,
  deploymentFailed: false,
};
describe("release review", () => {
  it("keeps missing evidence, failed checks and an unapproved preview out of the ready list", () => {
    expect(releasePhase([{ ...green, state: "CLOSED" }, green], emptyAssets, true)).toBe("review");
    expect(releasePhase([{ ...green, state: "CLOSED" }], emptyAssets, true)).toBe("closed");
    expect(releasePhase([null], emptyAssets, true)).toBe("unavailable");
    expect(releasePhase([{ ...green, checks: "PENDING" }], emptyAssets, true)).toBe("ci");
    expect(releasePhase([green, { ...green, checks: "FAILURE" }], emptyAssets, true)).toBe(
      "failed",
    );
    expect(releasePhase([{ ...green, changesRequested: true }], emptyAssets, true)).toBe("review");
    expect(
      releasePhase([green], { ...emptyAssets, before: "https://assets.example/a" }, false),
    ).toBe("review");
    expect(releasePhase([green], emptyAssets, false)).toBe("ready");
    expect(releasePhase([], emptyAssets, true, [{ status: "exit 1" }])).toBe("failed");
  });
  it("matches relative paths across worktrees, normalizes renamed paths and refuses outside paths", () => {
    const a = ThreadId.make("a"),
      b = ThreadId.make("b"),
      win = ThreadId.make("win");
    const thread = (id: ThreadId, root: string) => ({ id, root, title: String(id) });
    const matches = findFileOverlaps(
      [thread(a, "/p"), thread(b, "/wt"), thread(win, "C:\\work")],
      [
        { thread_id: a, path: "/p/src/app.ts" },
        { thread_id: a, path: "src/./app.ts" },
        { thread_id: b, path: "src/app.ts" },
        { thread_id: win, path: "C:\\work\\src\\app.ts" },
        { thread_id: a, path: "../escape" },
        { thread_id: b, path: "../escape" },
        { thread_id: "other", path: "src/app.ts" },
      ],
    );
    expect(matches).toEqual([
      {
        path: "src/app.ts",
        threads: [
          { id: a, title: "a" },
          { id: b, title: "b" },
          { id: win, title: "win" },
        ],
      },
    ]);
  });
});

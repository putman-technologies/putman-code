import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { RepoWorkflowButtonRequest } from "@t3tools/contracts";
import type { GitHubRestInput } from "./GitHubRest.ts";
import { repoWorkflowButton } from "./repoWorkflowButton.ts";

const ref = { host: "github.com", cwd: "/project", repository: "team/project", number: 66 };
const workflow = { id: 45, name: "Dry run", path: ".github/workflows/dry.yml", state: "active" };
const yaml = `on:
  workflow_dispatch:
    inputs:
      action:
        required: true
        type: choice
        options: [check, stage]
      source_sha:
        required: true
        type: string
`;

function fakeGitHub(merged: boolean) {
  const posts: GitHubRestInput[] = [];
  const api = {
    rest: (input: GitHubRestInput) => {
      const path = input.path;
      let body: string;
      if (input.method === "POST") {
        posts.push(input);
        body = JSON.stringify({ workflow_run_id: 17 });
      } else if (path.endsWith("/pulls/66"))
        body = JSON.stringify({ merged, merge_commit_sha: "abc", base: { ref: "release/1.0" } });
      else if (path.includes("/actions/workflows?"))
        body = JSON.stringify({
          total_count: 2,
          workflows: [workflow, { ...workflow, id: 46, path: ".github/workflows/ci.yml" }],
        });
      else if (path.endsWith("/actions/workflows/45")) body = JSON.stringify(workflow);
      else if (path.endsWith("/dry.yml?ref=release%2F1.0")) body = yaml;
      else if (path.endsWith("/ci.yml?ref=release%2F1.0")) body = "on: [push, pull_request]";
      else throw new Error("Unexpected route " + path);
      return Effect.succeed({
        status: 200,
        headers: {},
        body,
        truncated: false,
        invalidUtf8: false,
      });
    },
  };
  return {
    posts,
    run: (request: RepoWorkflowButtonRequest) => repoWorkflowButton(api, { ...ref, request }),
  };
}

describe("PR workflow button", () => {
  it.effect("lists manual workflows and their inputs without running them", () =>
    Effect.gen(function* () {
      const host = fakeGitHub(false);
      expect(yield* host.run({ kind: "list" })).toMatchObject({
        kind: "list",
        base: "release/1.0",
        mergeSha: null,
        workflows: [
          {
            id: 45,
            fields: [
              { name: "action", options: ["check", "stage"] },
              { name: "source_sha", required: true },
            ],
          },
        ],
      });
      expect(host.posts).toHaveLength(0);
    }),
  );
  it.effect("dispatches once to the merged base branch and links the specific run", () =>
    Effect.gen(function* () {
      const host = fakeGitHub(true);
      const inputs = { action: "check", source_sha: "abc" };
      expect(yield* host.run({ kind: "run", workflowId: 45, inputs })).toMatchObject({
        kind: "dispatched",
        url: "https://github.com/team/project/actions/runs/17",
      });
      expect(host.posts).toMatchObject([
        {
          method: "POST",
          path: "repos/team/project/actions/workflows/45/dispatches",
          body: { ref: "release/1.0", inputs },
        },
      ]);
    }),
  );
  it.effect(
    "rejects unmerged pull requests, missing inputs and unknown choices before dispatch",
    () =>
      Effect.gen(function* () {
        const open = fakeGitHub(false),
          merged = fakeGitHub(true);
        const beforeMerge = yield* Effect.flip(
          open.run({ kind: "run", workflowId: 45, inputs: {} }),
        );
        const missing = yield* Effect.flip(
          merged.run({ kind: "run", workflowId: 45, inputs: { action: "check" } }),
        );
        const invalid = yield* Effect.flip(
          merged.run({
            kind: "run",
            workflowId: 45,
            inputs: { action: "delete", source_sha: "abc" },
          }),
        );
        expect(beforeMerge.message).toMatch(/Merge this pull request/);
        expect(missing.message).toMatch(/source_sha/);
        expect(invalid.message).toMatch(/Invalid choice/);
        expect([...open.posts, ...merged.posts]).toHaveLength(0);
      }),
  );
});

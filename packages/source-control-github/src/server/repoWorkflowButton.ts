import type { RepoWorkflow, RepoWorkflowButtonResult, RepoWorkflowField } from "@t3tools/contracts";
import type { WorkflowButtonHostInput } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parse } from "yaml";
import type { GitHubRest } from "./GitHubRest.ts";

export class RepoWorkflowError extends Schema.TaggedError<RepoWorkflowError>()(
  "RepoWorkflowError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}
const fail = (detail: string) => new RepoWorkflowError({ detail });
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function workflowFields(yaml: string): readonly RepoWorkflowField[] | null {
  const doc: unknown = parse(yaml);
  if (!record(doc)) return null;
  const trigger = doc.on;
  if (
    trigger === "workflow_dispatch" ||
    (Array.isArray(trigger) && trigger.includes("workflow_dispatch"))
  )
    return [];
  if (!record(trigger) || !Object.hasOwn(trigger, "workflow_dispatch")) return null;
  const dispatch = trigger.workflow_dispatch;
  if (!record(dispatch) || !record(dispatch.inputs)) return [];
  return Object.entries(dispatch.inputs).map(([name, spec]) => {
    const field = record(spec) ? spec : {};
    const type = field.type;
    return {
      name,
      description: typeof field.description === "string" ? field.description : "",
      type:
        type === "choice" || type === "number" || type === "boolean" || type === "environment"
          ? type
          : "string",
      required: field.required === true,
      ...(field.default != null ? { defaultValue: String(field.default) } : {}),
      options: Array.isArray(field.options) ? field.options.map(String) : [],
    };
  });
}

const Pull = Schema.Struct({
  merged: Schema.Boolean,
  base: Schema.Struct({ ref: Schema.String }),
  merge_commit_sha: Schema.NullOr(Schema.String),
});
const Workflow = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  path: Schema.String,
  state: Schema.String,
});
const WorkflowPage = Schema.Struct({ workflows: Schema.Array(Workflow), total_count: Schema.Int });
const decodeRun = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ workflow_run_id: Schema.Int })),
);
const decodePull = Schema.decodeEffect(Schema.fromJsonString(Pull));
const decodeWorkflow = Schema.decodeEffect(Schema.fromJsonString(Workflow));
const decodePage = Schema.decodeEffect(Schema.fromJsonString(WorkflowPage));
const readFailure = () => fail("GitHub returned unreadable workflow information.");

export const repoWorkflowButton = Effect.fn("GitHub.workflowButton")(function* (
  api: Pick<GitHubRest["Service"], "rest">,
  input: WorkflowButtonHostInput,
) {
  const parts = input.repository.trim().split("/").slice(-2);
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === "..")
  )
    return yield* fail("Invalid GitHub repository.");
  const repo = parts.map(encodeURIComponent).join("/");
  const root = `repos/${repo}`;
  const get = (path: string, accept?: string) =>
    api.rest({
      host: input.host,
      operation: "readWorkflowButton",
      path: root + path,
      ...(accept ? { accept } : {}),
    });
  const pull = yield* get(`/pulls/${input.number}`).pipe(
    Effect.flatMap((r) => decodePull(r.body)),
    Effect.catchTags({ SchemaError: readFailureEffect }),
  );
  const base = pull.base.ref;
  const describe = Effect.fnUntraced(function* (entry: typeof Workflow.Type) {
    const file = /^\.github\/workflows\/([^/]+\.ya?ml)$/i.exec(entry.path)?.[1];
    if (entry.state !== "active" || !file) return null;
    const response = yield* get(
      `/contents/.github/workflows/${encodeURIComponent(file)}?ref=${encodeURIComponent(base)}`,
      "application/vnd.github.raw+json",
    ).pipe(Effect.catchTags({ GitHubApiNotFoundError: () => Effect.succeed(null) }));
    if (!response) return null;
    const fields = yield* Effect.try({
      try: () => workflowFields(response.body),
      catch: () => fail(`Could not read ${file}.`),
    });
    return fields === null
      ? null
      : ({ id: entry.id, name: entry.name, file, fields } satisfies RepoWorkflow);
  });
  if (input.request.kind === "list") {
    const entries: (typeof Workflow.Type)[] = [];
    for (let page = 1; ; page++) {
      const result = yield* get(`/actions/workflows?per_page=100&page=${page}`).pipe(
        Effect.flatMap((r) => decodePage(r.body)),
        Effect.catchTags({ SchemaError: readFailureEffect }),
      );
      entries.push(...result.workflows);
      if (result.workflows.length < 100 || entries.length >= result.total_count) break;
    }
    const workflows = (yield* Effect.forEach(entries, describe, { concurrency: 4 })).filter(
      (workflow) => workflow !== null,
    );
    return {
      kind: "list",
      base,
      mergeSha: pull.merged ? pull.merge_commit_sha : null,
      workflows,
    } satisfies RepoWorkflowButtonResult;
  }
  if (!pull.merged) return yield* fail("Merge this pull request before running the workflow.");
  const { workflowId, inputs } = input.request;
  const selected = yield* get(`/actions/workflows/${workflowId}`).pipe(
    Effect.flatMap((r) => decodeWorkflow(r.body)),
    Effect.catchTags({ SchemaError: readFailureEffect }),
  );
  const workflow = yield* describe(selected);
  if (!workflow)
    return yield* fail(
      "The selected workflow is no longer available for manual runs on the target branch.",
    );
  if (Object.keys(inputs).some((key) => !workflow.fields.some((f) => f.name === key)))
    return yield* fail("The workflow inputs changed. Reopen the form to refresh.");
  for (const f of workflow.fields) {
    const value = inputs[f.name] ?? f.defaultValue;
    if (f.required && (value === undefined || value === ""))
      return yield* fail(`Enter a value for ${f.name}.`);
    if (
      value !== undefined &&
      ((f.type === "choice" && !f.options.includes(value)) ||
        (f.type === "boolean" && !["true", "false"].includes(value)))
    )
      return yield* fail(`Invalid choice for ${f.name}.`);
  }
  const response = yield* api.rest({
    host: input.host,
    operation: "dispatchRepoWorkflow",
    method: "POST",
    path: `${root}/actions/workflows/${workflow.id}/dispatches`,
    body: { ref: base, inputs },
  });
  // Older GitHub hosts return 204. Link to the selected workflow there.
  const urlRoot = `https://${input.host}/${repo}/actions`;
  let url = `${urlRoot}/workflows/${encodeURIComponent(workflow.file)}`;
  if (response.body.trim()) {
    const run = yield* decodeRun(response.body).pipe(Effect.orElseSucceed(() => null));
    if (run && run.workflow_run_id > 0) url = `${urlRoot}/runs/${run.workflow_run_id}`;
  }
  return { kind: "dispatched", base, url } satisfies RepoWorkflowButtonResult;
});
function readFailureEffect() {
  return Effect.fail(readFailure());
}

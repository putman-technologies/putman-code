import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const short = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const note = TrimmedNonEmptyString.check(Schema.isMaxLength(4000));
const str = Schema.String;
const nullable = Schema.NullOr(str);
const projectId = ProjectId;
const id = short;
const version = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const size = (max: number) => Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: max }));
export const WorkerLimits = Schema.Struct({
  agents: size(32),
  browsers: size(16),
  turns: size(100),
  dollars: Schema.Finite.check(Schema.isBetween({ minimum: 0.01, maximum: 200 })),
});
export type WorkerLimits = typeof WorkerLimits.Type;
export const ShipCommit = Schema.Struct({ sha: str, title: str, pulls: Schema.Array(Schema.Int) });
export const ShipRange = Schema.Struct({
  head: Schema.optional(str),
  commits: Schema.Array(ShipCommit),
  files: Schema.Array(str),
});
export type ShipRange = typeof ShipRange.Type;
export const ShipManifest = Schema.Struct({
  ...ShipRange.fields,
  base: str,
  head: str,
  repository: str,
  token: str,
  holds: Schema.Array(str),
});
export type ShipManifest = typeof ShipManifest.Type;
export const CiReason = Schema.Literals(["pr", "baseline", "runner", "unknown"]);
export const TeamMember = Schema.Struct({
  key: str,
  name: str,
  submit: Schema.Boolean,
  approve: Schema.Boolean,
  release: Schema.Boolean,
});
export const TeamHold = Schema.Struct({ id: str, scope: str, reason: str, by: str });
export type TeamHold = typeof TeamHold.Type;
const taskState = Schema.Literals(["planned", "working", "done"]);
export const PlanTask = Schema.Struct({
  id,
  title: str,
  owner: str,
  criteria: str,
  threadId: ThreadId,
  dependencies: Schema.Array(str),
  state: taskState,
  version,
  budgetTurns: Schema.Int,
  budgetDollars: Schema.Number,
});
export const WorkerJob = Schema.Struct({
  id,
  task: str,
  kind: Schema.Literals(["agent", "browser"]),
  state: str,
  result: str,
  turns: Schema.Int,
  dollars: Schema.Number,
  branch: nullable,
  usedTurns: Schema.NullOr(Schema.Int),
  usedDollars: Schema.NullOr(Schema.Number),
});
export const TeamBoard = Schema.Struct({
  me: str,
  submit: Schema.Boolean,
  admin: Schema.Boolean,
  approve: Schema.Boolean,
  release: Schema.Boolean,
  members: Schema.Array(TeamMember),
  holds: Schema.Array(TeamHold),
  tasks: Schema.Array(PlanTask),
  jobs: Schema.Array(WorkerJob),
  limits: WorkerLimits,
  previewOrigin: str,
  audits: Schema.Array(
    Schema.Struct({ id: Schema.Int, action: str, by: str, at: str, revision: str }),
  ),
  threads: Schema.Array(Schema.Struct({ id: ThreadId, title: str })),
});
export type TeamBoard = typeof TeamBoard.Type;
export const TeamActions = [
  Schema.Struct({
    type: Schema.Literal("member"),
    projectId,
    key: short,
    name: short,
    submit: Schema.Boolean,
    approve: Schema.Boolean,
    release: Schema.Boolean,
  }),
  Schema.Struct({ type: Schema.Literal("hold"), projectId, id, scope: short, reason: note }),
  Schema.Struct({ type: Schema.Literal("lift"), projectId, id }),
  Schema.Struct({
    type: Schema.Literal("limits"),
    projectId,
    limits: WorkerLimits,
    previewOrigin: str.check(Schema.isMaxLength(1024)),
  }),
  Schema.Struct({
    type: Schema.Literal("task"),
    projectId,
    id,
    version,
    title: short,
    owner: short,
    criteria: note,
    threadId: Schema.NullOr(ThreadId),
    dependencies: Schema.Array(short).check(Schema.isMaxLength(64)),
    state: taskState,
  }),
  Schema.Struct({
    type: Schema.Literal("job"),
    projectId,
    id,
    task: short,
    kind: Schema.Literals(["agent", "browser"]),
  }),
  Schema.Struct({
    type: Schema.Literal("extendBudget"),
    projectId,
    task: short,
    id,
    turns: size(100),
    dollars: Schema.Finite.check(Schema.isBetween({ minimum: 0.01, maximum: 200 })),
  }),
  Schema.Struct({ type: Schema.Literal("cancelJob"), projectId, id }),
] as const;

import * as Schema from "effect/Schema";
import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PullRequestCheck } from "./pullRequest.ts";

const text = Schema.String;
const maybeText = Schema.NullOr(text);
export function coordinatorWebUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
const link = Schema.NullOr(text.check(Schema.makeFilter((s) => coordinatorWebUrl(s) !== null)));
export const ReviewAssets = Schema.Struct({ preview: link, before: link, after: link });
export type ReviewAssets = typeof ReviewAssets.Type;
export const CoordinatorChange = Schema.Struct({
  state: text,
  head: text,
  merge: maybeText,
  checks: maybeText,
  draft: Schema.Boolean,
  changesRequested: Schema.Boolean,
  conflict: Schema.Boolean,
  preview: link,
  before: link,
  after: link,
  deployedAt: Schema.NullOr(IsoDateTime),
  deploymentFailed: Schema.Boolean,
});
export type CoordinatorChange = typeof CoordinatorChange.Type;
export const ProductionDeployment = Schema.Struct({
  repository: text,
  host: text,
  revision: text,
  environment: text,
  state: text,
  at: IsoDateTime,
  url: link,
});
export type ProductionDeployment = typeof ProductionDeployment.Type;
export const FileOverlap = Schema.Struct({
  path: text,
  threads: Schema.Array(Schema.Struct({ id: ThreadId, title: text })),
});
export type FileOverlap = typeof FileOverlap.Type;
export const BoardPhase = Schema.Literals([
  "review",
  "ready",
  "failed",
  "ci",
  "merged",
  "deployed",
  "closed",
  "unavailable",
]);
export type BoardPhase = typeof BoardPhase.Type;
export const CoordinatorBoardItem = Schema.Struct({
  id: MessageId,
  threadId: ThreadId,
  coordinatorId: ThreadId,
  title: text,
  summary: text,
  at: IsoDateTime,
  scripts: Schema.Array(Schema.Struct({ name: text, status: text })),
  files: Schema.Array(text),
  phase: BoardPhase,
  revision: text,
  approved: Schema.Boolean,
  prepared: Schema.Boolean,
  live: Schema.NullOr(Schema.Boolean),
  assets: ReviewAssets,
  pulls: Schema.Array(
    Schema.Struct({
      number: Schema.Number,
      repository: text,
      url: link,
      evidence: Schema.NullOr(CoordinatorChange),
      checks: Schema.Array(PullRequestCheck),
    }),
  ),
});
export type CoordinatorBoardItem = typeof CoordinatorBoardItem.Type;
export const CoordinatorBoard = Schema.Struct({
  items: Schema.Array(CoordinatorBoardItem),
  overlaps: Schema.Array(FileOverlap),
  questions: Schema.Array(
    Schema.Struct({
      id: ThreadId,
      title: text,
      kind: Schema.Literals(["question", "plan", "approval"]),
    }),
  ),
  production: Schema.NullOr(Schema.Array(ProductionDeployment)),
});
export type CoordinatorBoard = typeof CoordinatorBoard.Type;
const selection = Schema.Struct({ id: MessageId, revision: TrimmedNonEmptyString });
export const CoordinatorBoardAction = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("assets"),
    projectId: ProjectId,
    item: selection,
    assets: ReviewAssets,
  }),
  Schema.Struct({
    type: Schema.Literal("linkPull"),
    projectId: ProjectId,
    item: selection,
    url: text.check(Schema.isMaxLength(4096)),
  }),
  Schema.Struct({ type: Schema.Literal("approve"), projectId: ProjectId, item: selection }),
  Schema.Struct({
    type: Schema.Literal("prepare"),
    projectId: ProjectId,
    items: Schema.Array(selection).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
]);
export type CoordinatorBoardAction = typeof CoordinatorBoardAction.Type;

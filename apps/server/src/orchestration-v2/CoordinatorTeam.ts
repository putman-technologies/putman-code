import {
  ProjectCoordinatorError,
  ThreadId,
  type CoordinatorBoardAction,
  type ProjectId,
  type TeamBoard,
  type WorkerLimits,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { revision } from "./coordinatorBoardState.ts";
import type { ThreadManagementServiceShape } from "./ThreadManagementService.ts";

type Sql = SqlClient.SqlClient;
export type BoardActor = { key: string; label: string; admin: boolean };
export const workerActor: BoardActor = {
  key: "system-worker",
  label: "Queue worker",
  admin: false,
};
const fail = (message: string) => new ProjectCoordinatorError({ message });
const defaults: WorkerLimits = { agents: 2, browsers: 1, turns: 12, dollars: 3 };
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));
export const audit = (
  sql: Sql,
  project: ProjectId,
  action: string,
  actor: BoardActor,
  ref: string,
) =>
  sql`INSERT INTO coordinator_audit(project_id,action,actor_key,actor,revision) VALUES(${project},${action},${actor.key},${actor.label},${ref})`;
export const teamAccess = Effect.fn("CoordinatorTeam.access")(function* (
  sql: Sql,
  project: ProjectId,
  actor: BoardActor,
) {
  const [member] = yield* sql<{
    name: string;
    admin: number;
    submit: number;
    approve: number;
    ship: number;
  }>`SELECT * FROM coordinator_people WHERE project_id=${project} AND key=${actor.key}`;
  const admin = actor.admin || member?.admin === 1;
  return {
    named: !!member && !/^Device [^ ]+$/.test(member.name),
    actor: { ...actor, label: member?.name ?? actor.label },
    admin,
    submit: admin || member?.submit !== 0,
    approve: admin || member?.approve === 1,
    release: admin || member?.ship === 1,
  };
});
export const readLimits = Effect.fn("CoordinatorTeam.limits")(function* (
  sql: Sql,
  project: ProjectId,
) {
  const [row] = yield* sql<
    WorkerLimits & { preview_origin: string }
  >`SELECT * FROM coordinator_team_settings WHERE project_id=${project}`;
  return {
    limits: row
      ? { agents: row.agents, browsers: row.browsers, turns: row.turns, dollars: row.dollars }
      : defaults,
    previewOrigin: row?.preview_origin ?? "",
  };
});
type TaskRow = {
  id: string;
  title: string;
  owner: string;
  criteria: string;
  thread_id: string;
  deps: string;
  state: "planned" | "working" | "done";
  version: number;
  extra_dollars: number;
  extra_turns: number;
  budget_turns: number;
  budget_dollars: number;
};
const taskRows = (sql: Sql, p: ProjectId) =>
  sql<TaskRow>`SELECT * FROM coordinator_plan WHERE project_id=${p} ORDER BY rowid`;
export const listHolds = (sql: Sql, p: ProjectId) =>
  sql<{
    id: string;
    scope: string;
    reason: string;
    by: string;
  }>`SELECT id,scope,reason,actor AS "by" FROM coordinator_holds WHERE project_id=${p} ORDER BY id`;
export const readTeam = Effect.fn("CoordinatorTeam.read")(function* (
  sql: Sql,
  p: ProjectId,
  actor: BoardActor,
  threads: TeamBoard["threads"],
) {
  if (actor.key !== workerActor.key)
    yield* sql`INSERT OR IGNORE INTO coordinator_people(project_id,key,name) VALUES(${p},${actor.key},${actor.label})`;
  const rights = yield* teamAccess(sql, p, actor);
  const members = yield* sql<{
    key: string;
    name: string;
    submit: number;
    approve: number;
    ship: number;
  }>`SELECT key,name,submit,approve,ship FROM coordinator_people WHERE project_id=${p} ORDER BY name,key`;
  const tasks = (yield* taskRows(sql, p)).map((t) => ({
    id: t.id,
    title: t.title,
    owner: t.owner,
    criteria: t.criteria,
    state: t.state,
    version: t.version,
    threadId: ThreadId.make(t.thread_id),
    dependencies: decode(t.deps),
    budgetTurns: t.budget_turns + t.extra_turns,
    budgetDollars: t.budget_dollars + t.extra_dollars,
  }));
  const jobs = yield* sql<
    TeamBoard["jobs"][number]
  >`SELECT id,task,kind,state,result,branch,turns,dollars,used_turns AS usedTurns,used_dollars AS usedDollars FROM coordinator_jobs WHERE project_id=${p} ORDER BY created DESC,rowid DESC LIMIT 100`;
  const audits = yield* sql<
    TeamBoard["audits"][number]
  >`SELECT rowid AS id,action,actor AS "by",at,revision FROM coordinator_audit WHERE project_id=${p} ORDER BY rowid DESC LIMIT 50`;
  return {
    me: actor.key,
    admin: rights.admin,
    submit: rights.submit,
    approve: rights.approve,
    release: rights.release,
    members: members.map((m) => ({
      key: m.key,
      name: m.name,
      submit: !!m.submit,
      approve: !!m.approve,
      release: !!m.ship,
    })),
    tasks,
    jobs,
    audits,
    threads,
    holds: yield* listHolds(sql, p),
    ...(yield* readLimits(sql, p)),
  } satisfies TeamBoard;
});
export function matchingHolds(
  holds: TeamBoard["holds"],
  files: readonly string[],
  pulls: readonly number[],
) {
  return holds
    .filter(
      (h) =>
        h.scope === "*" ||
        (h.scope.startsWith("#")
          ? pulls.includes(Number(h.scope.slice(1)))
          : files.some((f) => f === h.scope || f.startsWith(h.scope.replace(/\/$/, "") + "/"))),
    )
    .map((h) => h.reason);
}
type Operation = Extract<
  CoordinatorBoardAction,
  { type: "member" | "hold" | "lift" | "limits" | "task" | "job" | "cancelJob" | "extendBudget" }
>;
export const isTeamAction = (a: CoordinatorBoardAction): a is Operation =>
  ["member", "hold", "lift", "limits", "task", "job", "cancelJob", "extendBudget"].includes(a.type);
export const changeTeam = Effect.fn("CoordinatorTeam.change")(function* (
  sql: Sql,
  input: Operation,
  actor: BoardActor,
  threads: ThreadManagementServiceShape,
) {
  const p = input.projectId;
  const rights = yield* teamAccess(sql, p, actor);
  actor = rights.actor;
  const target = ThreadId.make("coordinator-" + encodeURIComponent(p) + "-0");
  if (["member", "limits", "extendBudget"].includes(input.type) && !rights.admin)
    return yield* fail("A project administrator must authorize this change.");
  if (["hold", "lift"].includes(input.type) && !rights.release)
    return yield* fail("Release permission is required to change a hold.");
  if (!rights.submit && ["task", "job", "cancelJob"].includes(input.type))
    return yield* fail("Project submission permission is required.");
  if (input.type === "member") {
    const rows =
      yield* sql`UPDATE coordinator_people SET name=${input.name},submit=${+input.submit},approve=${+input.approve},ship=${+input.release} WHERE key=${input.key} AND project_id=${p} RETURNING key`;
    if (!rows.length) return yield* fail("Open the board on that person's device first.");
  } else if (input.type === "hold") {
    const scope = input.scope.trim();
    if (
      scope !== "*" &&
      !/^#[1-9]\d*$/.test(scope) &&
      (!/^[\w./-]+$/.test(scope) ||
        scope.startsWith("/") ||
        scope
          .replace(/\/$/, "")
          .split("/")
          .some((v) => !v || v === ".." || v === "."))
    )
      return yield* fail("Use *, a PR number such as #50, or a repository path.");
    yield* sql`INSERT INTO coordinator_holds(project_id,id,scope,reason,actor) VALUES(${p},${input.id},${scope},${input.reason},${actor.label}) ON CONFLICT(project_id,id) DO NOTHING`;
  } else if (input.type === "lift") {
    yield* sql`DELETE FROM coordinator_holds WHERE project_id=${p} AND id=${input.id}`;
  } else if (input.type === "limits") {
    const l = input.limits;
    if (input.previewOrigin && !/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(input.previewOrigin))
      return yield* fail("Enter an HTTPS origin for the site's authenticated previews.");
    if (l.browsers > l.agents)
      return yield* fail("Browser slots must fit within the project worker limit.");
    yield* sql`INSERT INTO coordinator_team_settings VALUES(${p},${l.agents},${l.browsers},${l.turns},${l.dollars},${input.previewOrigin}) ON CONFLICT(project_id) DO UPDATE SET agents=excluded.agents,browsers=excluded.browsers,turns=excluded.turns,dollars=excluded.dollars,preview_origin=excluded.preview_origin`;
  } else if (input.type === "task") {
    if (!input.threadId) return yield* fail("Choose the originating feature chat.");
    const thread = yield* threads.getThreadShell(input.threadId);
    if (
      !thread ||
      thread.deletedAt ||
      thread.projectId !== p ||
      thread.id.startsWith("coordinator-")
    )
      return yield* fail("Choose a feature chat in this project.");
    const all = yield* taskRows(sql, p);
    const old = all.find((t) => t.id === input.id);
    if ((old?.version ?? 0) !== input.version)
      return yield* fail("This task changed. Refresh before editing.");
    const deps = [...new Set(input.dependencies)];
    const byId = new Map(all.map((t) => [t.id, t]));
    const seen = new Set<string>();
    const pending = [...deps];
    while (pending.length) {
      const id = pending.pop()!;
      if (id === input.id) return yield* fail("Task dependencies cannot form a cycle.");
      if (seen.has(id)) continue;
      seen.add(id);
      const d = byId.get(id);
      if (!d) return yield* fail("A dependency no longer exists.");
      pending.push(...decode(d.deps));
    }
    if (input.state !== "planned" && deps.some((id) => byId.get(id)?.state !== "done"))
      return yield* fail("Complete the dependencies first.");
    if (
      old?.state === "done" &&
      input.state !== "done" &&
      all.some((t) => t.state !== "planned" && decode(t.deps).includes(input.id))
    )
      return yield* fail("A dependent task already started.");
    const active =
      yield* sql`SELECT 1 FROM coordinator_jobs WHERE project_id=${p} AND task=${input.id} AND state IN ('queued','running','cancelling') LIMIT 1`;
    if (active.length) return yield* fail("Finish or cancel the worker before editing this task.");
    const { limits } = yield* readLimits(sql, p);
    yield* sql`INSERT INTO coordinator_plan(project_id,id,title,owner,criteria,thread_id,deps,state,version,budget_turns,budget_dollars) VALUES(${p},${input.id},${input.title},${input.owner},${input.criteria},${input.threadId},${encode(deps)},${input.state},1,${limits.turns},${limits.dollars}) ON CONFLICT(project_id,id) DO UPDATE SET title=excluded.title,owner=excluded.owner,criteria=excluded.criteria,thread_id=excluded.thread_id,deps=excluded.deps,state=excluded.state,version=coordinator_plan.version+1`;
  } else if (input.type === "job") {
    const { limits } = yield* readLimits(sql, p);
    const all = yield* taskRows(sql, p);
    const task = all.find((t) => t.id === input.task);
    if (
      !task ||
      task.state === "done" ||
      decode(task.deps).some((id) => !all.some((t) => t.id === id && t.state === "done"))
    )
      return yield* fail("This task is finished or blocked by another task.");
    const existing =
      yield* sql`SELECT 1 FROM coordinator_jobs WHERE project_id=${p} AND id=${input.id}`;
    if (existing.length) return { threadId: target };
    const [used] = yield* sql<{
      turns: number;
      dollars: number;
    }>`SELECT COALESCE(SUM(COALESCE(used_turns,turns)),0) turns,COALESCE(SUM(COALESCE(used_dollars,dollars)),0) dollars FROM coordinator_jobs WHERE project_id=${p} AND task=${task.id} AND kind='agent'`;
    const shell = yield* threads.getThreadShell(ThreadId.make(task.thread_id));
    if (!shell || shell.deletedAt || shell.projectId !== p)
      return yield* fail("Feature chat unavailable.");
    const [previous] = yield* sql<{
      branch: string;
    }>`SELECT branch FROM coordinator_jobs WHERE project_id=${p} AND task=${task.id} AND kind=\'agent\' AND state=\'completed\' AND branch IS NOT NULL ORDER BY rowid DESC LIMIT 1`;
    const baseRef = previous?.branch ?? shell.branch ?? "HEAD";
    const turns = Math.min(limits.turns, task.budget_turns + task.extra_turns - (used?.turns ?? 0));
    const available = task.budget_dollars + task.extra_dollars - (used?.dollars ?? 0);
    const dollars = Math.floor((Math.min(limits.dollars, available) + 1e-9) * 100) / 100;
    if (input.kind === "agent" && (turns < 1 || dollars < 0.01))
      return yield* fail(
        "The task budget is exhausted. An administrator can approve another allowance.",
      );
    const rows =
      yield* sql`INSERT OR IGNORE INTO coordinator_jobs(project_id,id,task,version,base_ref,kind,state,prompt,turns,dollars) VALUES(${p},${input.id},${task.id},${task.version},${baseRef},${input.kind},'queued',${task.title + "\nAcceptance criteria:\n" + task.criteria},${input.kind === "agent" ? turns : 0},${input.kind === "agent" ? dollars : 0}) RETURNING id`;
    if (!rows.length) return yield* fail("A worker is already assigned to this task.");
  } else if (input.type === "extendBudget") {
    const added =
      yield* sql`INSERT OR IGNORE INTO coordinator_budget_grants VALUES(${p},${input.id}) RETURNING id`;
    if (added.length) {
      const rows =
        yield* sql`UPDATE coordinator_plan SET extra_turns=extra_turns+${input.turns},extra_dollars=extra_dollars+${input.dollars} WHERE project_id=${p} AND id=${input.task} RETURNING id`;
      if (!rows.length) return yield* fail("Task not found.");
    }
  } else {
    yield* sql`UPDATE coordinator_jobs SET state=CASE state WHEN 'queued' THEN 'cancelled' ELSE 'cancelling' END,used_turns=CASE WHEN state='queued' THEN 0 ELSE used_turns END,used_dollars=CASE WHEN state='queued' THEN 0 ELSE used_dollars END WHERE project_id=${p} AND id=${input.id} AND state IN ('queued','running')`;
  }
  yield* audit(
    sql,
    p,
    input.type,
    actor,
    "id" in input ? input.id : "key" in input ? input.key : "project",
  );
  return { threadId: target };
});
export function actorFromSession(
  s: { sessionId: string; subject: string; scopes: readonly string[]; proofKeyThumbprint?: string },
  label: string,
) {
  return {
    key: revision(
      s.proofKeyThumbprint
        ? ["proof-key", s.proofKeyThumbprint]
        : s.subject === "desktop-bootstrap" && s.scopes.includes("access:write")
          ? ["local-desktop-owner"]
          : ["paired-client", s.sessionId],
    ),
    label: label || "Paired device",
    admin:
      ["administrative-bootstrap", "desktop-bootstrap"].includes(s.subject) &&
      s.scopes.includes("access:write"),
  };
}

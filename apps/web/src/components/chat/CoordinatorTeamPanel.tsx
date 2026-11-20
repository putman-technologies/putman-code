import { randomUUID } from "../../lib/utils";
import { type CoordinatorBoardAction, type ProjectId, type TeamBoard } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState, type FormEvent } from "react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

type Props = {
  team: TeamBoard;
  projectId: ProjectId;
  disabled: boolean;
  act: (a: CoordinatorBoardAction) => Promise<boolean>;
};
type Task = TeamBoard["tasks"][number];
const field = "rounded border bg-background px-2 py-1";
function fields(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  const data = new FormData(e.currentTarget);
  return {
    value: (key: string) => String(data.get(key) ?? "").trim(),
    checked: (key: string) => data.has(key),
    list: (key: string) => data.getAll(key).map(String),
  };
}
function TaskEditor({ team, projectId, disabled, act, task }: { task?: Task } & Props) {
  const gt = useGT();
  const [editing, setEditing] = useState(false);
  return (
    <div className="space-y-2">
      <Button size="xs" variant="outline" disabled={disabled} onClick={() => setEditing(!editing)}>
        {editing ? gt("Cancel") : task ? gt("Edit") : gt("Add task")}
      </Button>
      {editing && (
        <form
          className="grid gap-2"
          onSubmit={async (e) => {
            const form = fields(e);
            const thread = team.threads.find((t) => t.id === form.value("thread"));
            const state = form.value("state");
            if (
              await act({
                type: "task",
                projectId,
                id: task?.id ?? randomUUID(),
                version: task?.version ?? 0,
                title: form.value("title"),
                owner: form.value("owner"),
                criteria: form.value("criteria"),
                threadId: thread?.id ?? null,
                dependencies: form.list("deps"),
                state: state === "done" ? "done" : state === "working" ? "working" : "planned",
              })
            )
              setEditing(false);
          }}
        >
          <label>
            {gt("Title")}
            <Input name="title" maxLength={200} required defaultValue={task?.title} />
          </label>
          <label>
            {gt("Owner")}
            <Input name="owner" maxLength={200} required defaultValue={task?.owner} />
          </label>
          <label>
            {gt("Acceptance criteria")}
            <textarea
              name="criteria"
              maxLength={4000}
              required
              className={field + " block w-full"}
              defaultValue={task?.criteria}
            />
          </label>
          <label>
            {gt("Feature chat")}{" "}
            <select className={field} name="thread" required defaultValue={task?.threadId ?? ""}>
              <option value="" />
              {team.threads.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            {gt("Status")}{" "}
            <select className={field} name="state" defaultValue={task?.state ?? "planned"}>
              <option value="planned">{gt("Planned")}</option>
              <option value="working">{gt("Working")}</option>
              <option value="done">{gt("Done")}</option>
            </select>
          </label>
          {team.tasks.some((t) => t.id !== task?.id) && (
            <fieldset>
              <legend>{gt("Dependencies")}</legend>
              {team.tasks
                .filter((t) => t.id !== task?.id)
                .map((t) => (
                  <label className="block" key={t.id}>
                    <input
                      type="checkbox"
                      name="deps"
                      value={t.id}
                      defaultChecked={task?.dependencies.includes(t.id)}
                    />{" "}
                    {t.title}
                  </label>
                ))}
            </fieldset>
          )}
          <Button type="submit" size="xs" disabled={disabled}>
            {gt("Save")}
          </Button>
        </form>
      )}
    </div>
  );
}
export function CoordinatorTeamPanel(props: Props & { open: (id: Task["threadId"]) => void }) {
  const { team, projectId, disabled, act, open } = props;
  const gt = useGT();
  return (
    <div className="space-y-3 text-sm">
      <details open>
        <summary className="cursor-pointer font-medium">
          {gt("Project plan")} ({team.tasks.length})
        </summary>
        <div className="mt-2 space-y-2">
          {team.tasks.map((task) => {
            const blockers = team.tasks.filter(
              (t) => task.dependencies.includes(t.id) && t.state !== "done",
            );
            const jobs = team.jobs.filter((j) => j.task === task.id);
            const active = jobs.some((j) => ["queued", "running", "cancelling"].includes(j.state));
            return (
              <section key={task.id} className="space-y-1 rounded-md border p-2">
                <b>{task.title}</b> · {task.owner} · {task.state}
                <p className="whitespace-pre-wrap">{task.criteria}</p>
                <p className="text-xs text-muted-foreground">
                  {gt("Turns")} · {task.budgetTurns} · ${task.budgetDollars.toFixed(2)}
                </p>
                <button className="text-primary underline" onClick={() => open(task.threadId)}>
                  {team.threads.find((t) => t.id === task.threadId)?.title ??
                    gt("Open feature chat")}
                </button>
                {blockers.length > 0 && (
                  <p>
                    {gt("Blocked by")} {blockers.map((t) => t.title).join(", ")}
                  </p>
                )}
                {team.submit && (
                  <div className="flex flex-wrap gap-2">
                    <TaskEditor key={task.version} {...props} task={task} />
                    {(["agent", "browser"] as const).map((kind) => (
                      <Button
                        key={kind}
                        size="xs"
                        variant="ghost"
                        disabled={disabled || active || !!blockers.length || task.state === "done"}
                        onClick={() =>
                          void act({
                            type: "job",
                            projectId,
                            id: randomUUID(),
                            task: task.id,
                            kind,
                          })
                        }
                      >
                        {kind === "agent" ? gt("Run agent") : gt("Run browser tests")}
                      </Button>
                    ))}
                  </div>
                )}
                {jobs.map((j) => (
                  <div key={j.id} className="break-words text-xs">
                    {j.kind} · {j.state}{" "}
                    {j.kind === "agent" && (
                      <span>
                        · {gt("Turns")} {j.usedTurns ?? "…"}/{j.turns} · $
                        {j.usedDollars?.toFixed(2) ?? "…"}/{j.dollars.toFixed(2)}{" "}
                      </span>
                    )}{" "}
                    {j.branch && <code>{j.branch}</code>} {j.result}
                    {team.submit && ["queued", "running"].includes(j.state) && (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={disabled}
                        onClick={() => void act({ type: "cancelJob", projectId, id: j.id })}
                      >
                        {gt("Cancel")}
                      </Button>
                    )}
                  </div>
                ))}
                {team.admin && (
                  <details>
                    <summary>{gt("Extend task budget")}</summary>
                    <form
                      className="flex flex-wrap items-end gap-2"
                      onSubmit={async (e) => {
                        const f = fields(e);
                        await act({
                          type: "extendBudget",
                          projectId,
                          id: randomUUID(),
                          task: task.id,
                          turns: Number(f.value("turns")),
                          dollars: Number(f.value("dollars")),
                        });
                      }}
                    >
                      <label>
                        {gt("Turns")}
                        <Input type="number" min="1" max="100" name="turns" required />
                      </label>
                      <label>
                        USD
                        <Input
                          type="number"
                          min=".01"
                          max="200"
                          step=".01"
                          name="dollars"
                          required
                        />
                      </label>
                      <Button size="xs" type="submit" disabled={disabled}>
                        {gt("Approve")}
                      </Button>
                    </form>
                  </details>
                )}
              </section>
            );
          })}
          {team.submit && <TaskEditor {...props} />}
        </div>
      </details>
      <details open={team.holds.length > 0 || undefined}>
        <summary className="cursor-pointer font-medium">
          {gt("Release holds")} ({team.holds.length})
        </summary>
        {team.holds.map((h) => (
          <div key={h.id}>
            <code>{h.scope}</code> · {h.reason} · {h.by}{" "}
            {team.release && (
              <Button
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() => void act({ type: "lift", projectId, id: h.id })}
              >
                {gt("Lift hold")}
              </Button>
            )}
          </div>
        ))}
        {team.release && (
          <form
            className="mt-2 grid gap-2"
            onSubmit={async (e) => {
              const el = e.currentTarget;
              const f = fields(e);
              if (
                await act({
                  type: "hold",
                  projectId,
                  id: randomUUID(),
                  scope: f.value("scope"),
                  reason: f.value("reason"),
                })
              )
                el.reset();
            }}
          >
            <label>
              {gt("Project, PR or path")}
              <Input name="scope" placeholder="* / #42" required maxLength={200} />
            </label>
            <label>
              {gt("Reason")}
              <Input name="reason" required maxLength={4000} />
            </label>
            <Button size="xs" type="submit" disabled={disabled}>
              {gt("Add hold")}
            </Button>
          </form>
        )}
      </details>
      <details>
        <summary className="cursor-pointer font-medium">{gt("Project access and workers")}</summary>
        <p className="my-2 break-all text-xs">
          {gt("Project")} <code>{projectId}</code>
          <br />
          {gt("This device")} <code>{team.me}</code>
        </p>
        {team.members.map((m) => (
          <form
            className="my-2 flex flex-wrap items-center gap-2"
            key={JSON.stringify(m)}
            onSubmit={async (e) => {
              const f = fields(e);
              await act({
                type: "member",
                projectId,
                key: m.key,
                name: f.value("name"),
                submit: f.checked("submit"),
                approve: f.checked("approve"),
                release: f.checked("release"),
              });
            }}
          >
            <label>
              {gt("Name")}{" "}
              <input
                className={field}
                name="name"
                defaultValue={m.name}
                required
                maxLength={200}
                disabled={!team.admin || disabled}
              />
            </label>
            {(["submit", "approve", "release"] as const).map((role) => (
              <label key={role}>
                <input
                  type="checkbox"
                  name={role}
                  defaultChecked={m[role]}
                  disabled={!team.admin || disabled}
                />{" "}
                {role === "submit"
                  ? gt("Submit")
                  : role === "approve"
                    ? gt("Approve")
                    : gt("Release")}
              </label>
            ))}
            {team.admin && (
              <Button size="xs" type="submit" disabled={disabled}>
                {gt("Save")}
              </Button>
            )}
          </form>
        ))}
        <form
          key={JSON.stringify([team.limits, team.previewOrigin])}
          className="grid gap-2"
          onSubmit={async (e) => {
            const f = fields(e);
            await act({
              type: "limits",
              projectId,
              limits: {
                agents: Number(f.value("agents")),
                browsers: Number(f.value("browsers")),
                turns: Number(f.value("turns")),
                dollars: Number(f.value("dollars")),
              },
              previewOrigin: f.value("origin"),
            });
          }}
        >
          <fieldset disabled={!team.admin || disabled} className="grid grid-cols-2 gap-2">
            {(["agents", "browsers", "turns", "dollars"] as const).map((k) => (
              <label key={k}>
                {k === "agents"
                  ? gt("Worker slots")
                  : k === "browsers"
                    ? gt("Browser slots")
                    : k === "turns"
                      ? gt("Turns per task")
                      : "USD / " + gt("Task")}
                <Input
                  name={k}
                  type="number"
                  min={k === "dollars" ? 0.01 : 1}
                  max={{ agents: 32, browsers: 16, turns: 100, dollars: 200 }[k]}
                  step={k === "dollars" ? ".01" : 1}
                  required
                  defaultValue={team.limits[k]}
                />
              </label>
            ))}
            <label className="col-span-2">
              {gt("Private preview origin")}
              <Input
                name="origin"
                type="url"
                placeholder="https://preview.example.com"
                defaultValue={team.previewOrigin}
              />
            </label>
          </fieldset>
          {team.admin && (
            <Button size="xs" type="submit" disabled={disabled}>
              {gt("Save")}
            </Button>
          )}
        </form>
        <details className="mt-2">
          <summary>{gt("Activity")}</summary>
          {team.audits.map((a) => (
            <p className="break-all text-xs" key={a.id}>
              {new Date(a.at).toLocaleString()} · {a.by} · {a.action} · {a.revision}
            </p>
          ))}
        </details>
      </details>
    </div>
  );
}

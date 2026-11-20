import { useAtomValue } from "@effect/atom-react";
import {
  coordinatorWebUrl,
  type BoardPhase,
  type CoordinatorBoard as Board,
  type CoordinatorBoardItem,
  type CoordinatorBoardAction,
  type EnvironmentId,
  type ProjectId,
  type ReviewAssets,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { msg, useGT, useMessages } from "gt-react";
import { ClipboardListIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { useRef, useState } from "react";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { coordinatorBoardQuery, coordinatorOverlapsQuery } from "../../state/projects";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

type Project = { environmentId: EnvironmentId; projectId: ProjectId; title: string };
type OpenThread = (threadId: ThreadId, environmentId: EnvironmentId) => void;
const phases = {
  review: msg("Needs review"),
  ready: msg("Ready for release"),
  failed: msg("Failed"),
  ci: msg("CI running"),
  merged: msg("Merged"),
  deployed: msg("Deployed"),
  closed: msg("Closed"),
  unavailable: msg("Status unavailable"),
} satisfies Record<BoardPhase, unknown>;
const attentionNeeded = (item: CoordinatorBoardItem) =>
  ["review", "failed", "unavailable"].includes(item.phase);
const projectKey = (p: Project) => JSON.stringify([p.environmentId, p.projectId]);
const date = (stamp: string) => new Date(stamp).toLocaleString();
const query = (p: Project) =>
  coordinatorBoardQuery({ environmentId: p.environmentId, input: { projectId: p.projectId } });

const failedDeployment = (board: Board) =>
  ["ERROR", "FAILURE"].includes(board.production?.[0]?.state ?? "");
const needsAttention = (board: Board) =>
  board.questions.length > 0 ||
  board.overlaps.length > 0 ||
  failedDeployment(board) ||
  board.items.some(attentionNeeded);
const allClearAtom = Atom.family((projects: readonly Project[]) =>
  Atom.make((get) =>
    projects.every((p) => {
      const state = get(query(p));
      return state._tag === "Success" && !needsAttention(state.value);
    }),
  ),
);
function AttentionEmpty({ projects }: { projects: readonly Project[] }) {
  const gt = useGT();
  const clear = useAtomValue(allClearAtom(projects));
  return clear ? (
    <p role="status" className="rounded-md border p-4 text-sm text-muted-foreground">
      {gt("Nothing needs your attention.")}
    </p>
  ) : null;
}

function WebLink({ url, children }: { url: string | null; children: React.ReactNode }) {
  const href = coordinatorWebUrl(url);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-primary underline underline-offset-2"
    >
      {children}
      <ExternalLinkIcon className="size-3 shrink-0" aria-hidden />
    </a>
  ) : null;
}

export function ChatOverlapNotice({
  projectId,
  environmentId,
  threadId,
  onOpen,
}: {
  projectId: ProjectId;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onOpen: OpenThread;
}) {
  const gt = useGT();
  const result = useAtomValue(coordinatorOverlapsQuery({ environmentId, input: { projectId } }));
  if (result._tag !== "Success") return null;
  const matches = result.value.filter((x) => x.threads.some((t) => t.id === threadId));
  if (!matches.length) return null;
  return (
    <details className="mx-3 my-1 max-h-32 overflow-auto rounded-md border border-warning/40 px-3 py-1 text-xs">
      <summary className="cursor-pointer font-medium">
        {gt("Overlapping files")} ({matches.length})
      </summary>
      {matches.map((m) => (
        <div key={m.path} className="my-1 flex flex-wrap gap-2">
          <code className="break-all">{m.path}</code>
          {m.threads
            .filter((t) => t.id !== threadId)
            .map((t) => (
              <button
                key={t.id}
                type="button"
                className="cursor-pointer text-primary underline"
                onClick={() => onOpen(t.id, environmentId)}
              >
                {t.title}
              </button>
            ))}
        </div>
      ))}
    </details>
  );
}

export function ReleaseBoardButton({
  projects,
  onOpen,
  startInProject = false,
}: {
  projects: readonly Project[];
  onOpen: OpenThread;
  startInProject?: boolean;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<string | null>(null);
  if (!projects.length) return null;
  const dismissAndOpen: OpenThread = (threadId, environmentId) => {
    setOpen(false);
    onOpen(threadId, environmentId);
  };
  const single = projects.find((p) => projectKey(p) === scope);
  return (
    <>
      <Button
        variant="ghost-muted"
        size="sm"
        onClick={() => {
          setScope(startInProject ? projectKey(projects[0]!) : null);
          setOpen(true);
        }}
      >
        <ClipboardListIcon aria-hidden />
        {gt("Release board")}
      </Button>
      {open && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogPopup className="w-[min(94vw,52rem)] max-w-none">
            <DialogHeader>
              <DialogTitle>{gt("Release board")}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <label className="flex items-center gap-3 text-sm font-medium">
                {gt("View")}
                <select
                  aria-label={gt("Release board view")}
                  className="min-w-0 rounded-md border bg-background px-3 py-1.5"
                  value={single ? projectKey(single) : ""}
                  onChange={(e) => setScope(e.target.value || null)}
                >
                  <option value="">{gt("Needs my attention")}</option>
                  {projects.map((p) => (
                    <option value={projectKey(p)} key={projectKey(p)}>
                      {p.title}
                    </option>
                  ))}
                </select>
              </label>
              {!single && <AttentionEmpty projects={projects} />}
              {(single ? [single] : projects).map((project) => (
                <ProjectReview
                  key={projectKey(project)}
                  project={project}
                  attention={!single}
                  onOpen={dismissAndOpen}
                  onProject={() => setScope(projectKey(project))}
                />
              ))}
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      )}
    </>
  );
}

function ProjectReview({
  project,
  attention,
  onOpen,
  onProject,
}: {
  project: Project;
  attention: boolean;
  onOpen: OpenThread;
  onProject: () => void;
}) {
  const gt = useGT();
  const { environmentId, projectId } = project;
  const atom = query(project);
  const state = useAtomValue(atom);
  const [selection, setSelection] = useState<ReadonlyMap<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const action = orchestrationEnvironment.coordinatorBoardAction;
  const allowed = useAtomValue(action.permissionAtom(environmentId));
  const run = useAtomCommand(action);
  const execute = async (input: CoordinatorBoardAction) => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(true);
    return run({ environmentId, input })
      .then((result) => {
        if (result._tag === "Success" && input.type === "prepare") {
          setSelection(new Map());
          onOpen(result.value.threadId, environmentId);
        }
        return result._tag === "Success";
      })
      .finally(() => {
        lock.current = false;
        setBusy(false);
        appAtomRegistry.refresh(atom);
      });
  };
  const header = (
    <div className="flex items-center justify-between gap-3">
      <h3 className="truncate text-base font-semibold">
        {attention ? (
          <button type="button" className="cursor-pointer hover:underline" onClick={onProject}>
            {project.title}
          </button>
        ) : (
          project.title
        )}
      </h3>
      <Button
        variant="ghost-muted"
        size="icon-xs"
        aria-label={gt("Refresh")}
        onClick={() => appAtomRegistry.refresh(atom)}
      >
        <RefreshCwIcon />
      </Button>
    </div>
  );
  if (state._tag !== "Success")
    return (
      <section>
        {header}
        <p role="status" className="text-sm text-muted-foreground">
          {state._tag === "Failure" ? gt("Project status unavailable") : gt("Loading…")}
        </p>
      </section>
    );
  const board = state.value;
  const pending = board.items.filter((i) =>
    attention ? attentionNeeded(i) : !["closed", "deployed"].includes(i.phase),
  );
  const picked = pending.filter(
    (i) => selection.get(i.id) === i.revision && ["ready", "merged"].includes(i.phase),
  );
  const open = (id: ThreadId) => onOpen(id, environmentId);
  const productionFailed = failedDeployment(board);
  if (attention && !needsAttention(board)) return null;
  return (
    <section className="space-y-3 rounded-lg border p-4">
      {header}
      {board.questions.map((q) => (
        <div key={q.id} className="flex items-center justify-between gap-2 text-sm">
          <span>{q.title}</span>
          <Button variant="outline" size="xs" onClick={() => open(q.id)}>
            {q.kind === "question"
              ? gt("Answer question")
              : q.kind === "plan"
                ? gt("Review plan")
                : gt("Review approval")}
          </Button>
        </div>
      ))}
      {attention && productionFailed && (
        <div className="flex justify-between text-sm">
          <span>{gt("Production deployment failed")}</span>
          <Button variant="outline" size="xs" onClick={onProject}>
            {gt("View deployment")}
          </Button>
        </div>
      )}
      {board.overlaps.length > 0 && (
        <details open={attention} className="text-sm">
          <summary className="cursor-pointer font-medium">
            {gt("Overlapping files")} ({board.overlaps.length})
          </summary>
          {board.overlaps.map((o) => (
            <div key={o.path} className="mt-1 flex flex-wrap items-center gap-2">
              <code className="break-all text-xs">{o.path}</code>
              {o.threads.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  className="cursor-pointer text-primary underline"
                  onClick={() => open(t.id)}
                >
                  {t.title}
                </button>
              ))}
            </div>
          ))}
        </details>
      )}
      {!attention && <LiveStatus board={board} />}
      <div className="space-y-2">
        {!attention && (
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-medium">{gt("Release queue")}</h4>
            <Button
              size="sm"
              disabled={!allowed || busy || !picked.length}
              onClick={() =>
                void execute({
                  type: "prepare",
                  projectId,
                  items: picked.map((i) => ({ id: i.id, revision: i.revision })),
                })
              }
            >
              {gt("Prepare release")}
              {picked.length > 0 && " (" + picked.length + ")"}
            </Button>
          </div>
        )}
        {pending.map((item) => (
          <Handoff
            key={item.id}
            item={item}
            project={project}
            disabled={!allowed || busy}
            onOpen={() => open(item.threadId)}
            onAction={execute}
            selectable={!attention && (item.phase === "ready" || item.phase === "merged")}
            selected={selection.get(item.id) === item.revision}
            onSelect={(checked) =>
              setSelection((prev) => {
                const next = new Map(prev);
                if (checked) next.set(item.id, item.revision);
                else next.delete(item.id);
                return next;
              })
            }
          />
        ))}
        {!pending.length &&
          (!attention ||
            (!board.questions.length && !board.overlaps.length && !productionFailed)) && (
            <p className="text-sm text-muted-foreground">
              {attention
                ? gt("Nothing needs your attention.")
                : gt("No handoffs are waiting for release.")}
            </p>
          )}
      </div>
      {!attention && board.items.some((i) => i.phase === "deployed" || i.phase === "closed") && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            {gt("Completed handoffs")}
          </summary>
          {board.items
            .filter((i) => i.phase === "deployed" || i.phase === "closed")
            .map((item) => (
              <Handoff
                key={item.id}
                item={item}
                project={project}
                disabled
                onOpen={() => open(item.threadId)}
                onAction={execute}
              />
            ))}
        </details>
      )}
    </section>
  );
}

function LiveStatus({ board }: { board: Board }) {
  const gt = useGT();
  const deployments = board.production;
  const lastSuccess = deployments?.find((d) => d.state === "SUCCESS");
  const latest = deployments?.[0];
  return (
    <div className="rounded-md bg-muted/60 p-3 text-sm">
      <h4 className="mb-1 font-semibold">{gt("What’s live?")}</h4>
      {lastSuccess ? (
        <div>
          {gt("Last successful production deployment")} ·{" "}
          <code>{lastSuccess.revision.slice(0, 10)}</code> ·{" "}
          <time dateTime={lastSuccess.at}>{date(lastSuccess.at)}</time>{" "}
          <WebLink url={lastSuccess.url}>{gt("Open site")}</WebLink>
        </div>
      ) : (
        <span className="text-muted-foreground">
          {deployments === null
            ? gt("Deployment data unavailable.")
            : gt("No successful production deployment found.")}
        </span>
      )}
      {board.items.some((i) => i.live) && (
        <ul className="mt-1 list-disc pl-5">
          {board.items
            .filter((i) => i.live)
            .map((i) => (
              <li key={i.id}>{i.title}</li>
            ))}
        </ul>
      )}
      {latest && latest !== lastSuccess && (
        <div>
          {gt("Latest deployment")} · {latest.state} · <code>{latest.revision.slice(0, 10)}</code> ·{" "}
          {date(latest.at)}
        </div>
      )}
    </div>
  );
}

function Handoff({
  item,
  project,
  disabled,
  onOpen,
  onAction,
  selectable = false,
  selected = false,
  onSelect,
}: {
  item: CoordinatorBoardItem;
  project: Project;
  disabled: boolean;
  onOpen: () => void;
  onAction: (input: CoordinatorBoardAction) => Promise<boolean>;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (v: boolean) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [pullUrl, setPullUrl] = useState("");
  const [inspect, setInspect] = useState(false);
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState<ReviewAssets>(item.assets);
  const retry = orchestrationEnvironment.coordinatorRetry;
  const retryAllowed = useAtomValue(retry.permissionAtom(project.environmentId));
  const rerun = useAtomCommand(retry);
  const [retrying, setRetrying] = useState(false);
  const retryLock = useRef(false);
  const ref = { id: item.id, revision: item.revision };
  const preview =
    item.assets.preview ?? item.pulls.find((p) => p.evidence?.preview)?.evidence?.preview ?? null;
  const assets = { before: item.assets.before, after: item.assets.after };
  const previews = Boolean(preview || assets.before || assets.after);
  const reviewReason =
    item.phase === "review"
      ? item.pulls.some((p) => p.evidence?.conflict)
        ? gt("Resolve merge conflicts")
        : item.pulls.some((p) => p.evidence?.draft)
          ? gt("Pull request is a draft")
          : item.pulls.some((p) => p.evidence?.changesRequested)
            ? gt("GitHub review required")
            : !item.approved && previews
              ? gt("Preview needs approval")
              : !item.pulls.length
                ? gt("No linked pull request")
                : gt("Passing CI has not been reported")
      : null;
  return (
    <article className="rounded-md border px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        {selectable && (
          <input
            type="checkbox"
            aria-label={item.title}
            checked={selected}
            disabled={disabled}
            onChange={(e) => onSelect?.(e.target.checked)}
          />
        )}
        <button
          type="button"
          aria-expanded={inspect}
          className="min-w-0 flex-1 cursor-pointer break-words text-left font-medium hover:underline"
          onClick={() => setInspect(!inspect)}
        >
          {item.title}
        </button>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${item.phase === "ready" || item.phase === "deployed" ? "bg-success/15 text-success-foreground" : item.phase === "failed" ? "bg-destructive/10 text-destructive" : item.phase === "review" ? "bg-warning/15 text-warning-foreground" : item.phase === "ci" ? "bg-info/15 text-info-foreground" : "bg-muted text-muted-foreground"}`}
        >
          {m(phases[item.phase])}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {reviewReason && <span>{reviewReason}</span>}
        {item.prepared && <span>{gt("Release plan requested")}</span>}
        {item.pulls.map((p) => (
          <WebLink key={p.url ?? p.repository + p.number} url={p.url}>
            #{p.number}
          </WebLink>
        ))}
        <button
          type="button"
          className="cursor-pointer text-primary hover:underline"
          onClick={() => setInspect(!inspect)}
        >
          {inspect ? gt("Hide details") : previews ? gt("Review preview") : gt("Review handoff")}
        </button>
      </div>
      {item.phase === "failed" &&
        item.pulls
          .filter(
            (p) =>
              p.url &&
              p.evidence?.state === "OPEN" &&
              ["FAILURE", "ERROR"].includes(p.evidence.checks ?? ""),
          )
          .map((p) => (
            <Button
              key={p.url}
              size="xs"
              variant="outline"
              disabled={!retryAllowed || retrying}
              onClick={async () => {
                if (!p.url || !p.evidence || retryLock.current) return;
                retryLock.current = true;
                setRetrying(true);
                await rerun({
                  environmentId: project.environmentId,
                  input: {
                    projectId: project.projectId,
                    host: new URL(p.url).host,
                    repository: p.repository,
                    number: p.number,
                    head: p.evidence.head,
                  },
                })
                  .then((r) => {
                    if (r._tag === "Success")
                      toastManager.add({ type: "success", title: gt("CI retry requested") });
                  })
                  .finally(() => {
                    retryLock.current = false;
                    setRetrying(false);
                    appAtomRegistry.refresh(query(project));
                  });
              }}
            >
              {gt("Retry CI")} · #{p.number}
            </Button>
          ))}
      {inspect && (
        <div className="mt-3 space-y-3 border-t pt-2">
          {item.summary && (
            <p className="max-h-40 overflow-auto whitespace-pre-wrap break-words">{item.summary}</p>
          )}
          {item.files.length > 0 && (
            <details>
              <summary className="cursor-pointer">
                {gt("Changed files")} ({item.files.length})
              </summary>
              {item.files.map((f) => (
                <code key={f} className="block break-all text-xs">
                  {f}
                </code>
              ))}
            </details>
          )}
          {item.scripts.map((s) => (
            <div key={s.name}>
              {s.name} · {s.status}
            </div>
          ))}
          {item.pulls.map((p) => (
            <div key={p.repository + p.number}>
              <div>
                #{p.number} · {p.evidence?.checks ?? gt("Checks unavailable")}{" "}
                {p.evidence?.head && <code>{p.evidence.head.slice(0, 8)}</code>}
              </div>
              {p.checks.map((c) => (
                <div className="pl-2 text-xs" key={JSON.stringify([c.name, c.url, c.description])}>
                  {c.name} · {c.status}
                </div>
              ))}
            </div>
          ))}
          {!disabled && (
            <details>
              <summary className="cursor-pointer">{gt("Link pull request")}</summary>
              <form
                className="mt-1 flex gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  await onAction({
                    type: "linkPull",
                    projectId: project.projectId,
                    item: ref,
                    url: pullUrl,
                  });
                }}
              >
                <Input
                  aria-label={gt("Pull request URL")}
                  type="url"
                  placeholder="https://github.com/…"
                  value={pullUrl}
                  onChange={(e) => setPullUrl(e.target.value)}
                />
                <Button size="xs" type="submit" disabled={!coordinatorWebUrl(pullUrl)}>
                  {gt("Link")}
                </Button>
              </form>
            </details>
          )}
          <WebLink url={preview}>{gt("Open preview")}</WebLink>
          {(assets.before || assets.after) && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(["before", "after"] as const).map((k) => (
                <figure key={k}>
                  <figcaption>{k === "before" ? gt("Before") : gt("After")}</figcaption>
                  {assets[k] ? (
                    <a href={assets[k]} rel="noopener noreferrer" target="_blank">
                      <img
                        src={assets[k]}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        alt={k === "before" ? gt("Before screenshot") : gt("After screenshot")}
                        className="max-h-64 w-full rounded border object-contain"
                      />
                    </a>
                  ) : (
                    <span>{gt("No screenshot")}</span>
                  )}
                </figure>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" size="xs" onClick={onOpen}>
              {gt("Open feature chat")}
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={disabled}
              onClick={() => {
                setDraft(item.assets);
                setEdit(!edit);
              }}
            >
              {gt("Edit preview links")}
            </Button>
            {item.phase === "review" && (
              <Button
                size="xs"
                disabled={disabled || item.approved}
                onClick={() =>
                  void onAction({ type: "approve", projectId: project.projectId, item: ref })
                }
              >
                {item.approved ? gt("Approved") : gt("Approve handoff")}
              </Button>
            )}
          </div>
          {edit && (
            <form
              className="space-y-2"
              onSubmit={async (e) => {
                e.preventDefault();
                const saved = await onAction({
                  type: "assets",
                  projectId: project.projectId,
                  item: ref,
                  assets: draft,
                });
                if (saved) setEdit(false);
              }}
            >
              {(["preview", "before", "after"] as const).map((k) => (
                <label className="block text-xs" key={k}>
                  {k === "preview"
                    ? gt("Preview URL")
                    : k === "before"
                      ? gt("Before screenshot URL")
                      : gt("After screenshot URL")}
                  <Input
                    type="url"
                    pattern="https://.+"
                    placeholder="https://"
                    value={draft[k] ?? ""}
                    onChange={(e) => setDraft({ ...draft, [k]: e.target.value.trim() || null })}
                  />
                </label>
              ))}
              <Button
                type="submit"
                size="xs"
                disabled={disabled || Object.values(draft).some((v) => v && !coordinatorWebUrl(v))}
              >
                {gt("Save links")}
              </Button>
            </form>
          )}
        </div>
      )}
    </article>
  );
}

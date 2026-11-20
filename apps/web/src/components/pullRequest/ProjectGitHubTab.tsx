import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  coordinatorWebUrl,
  type CoordinatorBoard,
  type EnvironmentId,
  type ProjectId,
  type PullRequestListEntry,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { PullRequestGlyph } from "./pullRequestIcons";
import { RefreshCwIcon } from "lucide-react";
import { useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { coordinatorBoardQuery } from "../../state/projects";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { useEnvironmentQuery } from "../../state/query";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { ReleaseBoardButton } from "../chat/CoordinatorBoard";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { guideRunKey, useGuideRunStore } from "./guide/guideRunStore";

type Scope = { projectId: ProjectId; environmentId: EnvironmentId };
type Pull = Pick<PullRequestListEntry, "host" | "repository" | "number" | "url">;
type Review = (pull: Pull, code: boolean) => void;
const failure = (status: string) => status === "failure" || status === "action-required";
function summary(body: string) {
  return body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n\s*\n/)
    .map((p) =>
      p
        .split("\n")
        .filter((l) => !/^\s*(?:#{1,6}\s|\|)/.test(l))
        .map((l) => l.replace(/^\s*[-*]\s+(?:\[[ xX]\]\s+)?/, ""))
        .join(" ")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\*\*|`/g, "")
        .trim(),
    )
    .filter(Boolean)
    .slice(0, 2)
    .join(" ")
    .slice(0, 700);
}
function ChangeSummary({
  scope,
  pull,
  handoff,
  review,
}: {
  scope: Scope;
  pull: PullRequestListEntry;
  handoff?: string | undefined;
  review: Review;
}) {
  const gt = useGT(),
    navigate = useNavigate();
  const detail = useEnvironmentQuery(
    pullRequestEnvironment.detail({
      environmentId: scope.environmentId,
      input: {
        projectId: scope.projectId,
        host: pull.host,
        repository: pull.repository,
        number: pull.number,
        allowStale: false,
      },
    }),
  );
  const command = orchestrationEnvironment.coordinatorBoardAction;
  const canAsk = useAtomValue(command.permissionAtom(scope.environmentId)),
    ask = useAtomCommand(command);
  const [show, setShow] = useState(false),
    [question, setQuestion] = useState(""),
    [busy, setBusy] = useState(false);
  const attempt = useRef(""),
    lock = useRef(false);
  const prose = handoff?.trim() || summary(detail.data?.body ?? "");
  return (
    <div className="space-y-3">
      <p className="whitespace-pre-line break-words text-sm">{prose || pull.title}</p>
      <p className="break-all font-mono text-xs text-muted-foreground">
        {pull.headBranch} → {pull.baseBranch}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => review(pull, true)}>
          {gt("Review changes")}
        </Button>
        <Button size="sm" variant="outline" onClick={() => setShow(!show)} disabled={!canAsk}>
          {gt("Ask coordinator")}
        </Button>
      </div>
      {show && (
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!question.trim() || lock.current) return;
            lock.current = true;
            setBusy(true);
            attempt.current ||= randomUUID();
            try {
              const result = await ask({
                environmentId: scope.environmentId,
                input: {
                  type: "askPull",
                  projectId: scope.projectId,
                  url: pull.url,
                  question: question.trim(),
                  requestId: attempt.current,
                },
              });
              if (result._tag === "Success")
                await navigate({
                  to: "/$environmentId/$threadId",
                  params: { environmentId: scope.environmentId, threadId: result.value.threadId },
                });
            } finally {
              lock.current = false;
              setBusy(false);
            }
          }}
        >
          <Input
            aria-label={gt("Question about this change")}
            placeholder={gt("Question about this change")}
            required
            maxLength={4000}
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value);
              attempt.current = "";
            }}
          />
          <Button size="sm" type="submit" disabled={busy || !question.trim()}>
            {gt("Send")}
          </Button>
        </form>
      )}
    </div>
  );
}
function ProjectChanges({ scope, board }: { scope: Scope; board: CoordinatorBoard }) {
  const gt = useGT(),
    navigate = useNavigate();
  const github = board.github!;
  const [selected, setSelected] = useState("");
  const open = github.open ?? [];
  const pulls = [...open].sort(
    (a, b) =>
      Number(b.checksState === "failing") - Number(a.checksState === "failing") ||
      Number(b.viewerReviewRequested) - Number(a.viewerReviewRequested),
  );
  const chosen = pulls.find((p) => p.url === selected) ?? pulls[0];
  const handoff = (url: string) =>
    board.items.find((i) => i.pulls.some((p) => p.url?.toLowerCase() === url.toLowerCase()));
  const review: Review = (p, code) => {
    const ref = {
      projectId: scope.projectId,
      host: p.host,
      repository: p.repository,
      number: p.number,
    };
    useGuideRunStore
      .getState()
      .showPageDetailTab(guideRunKey(scope.environmentId, ref), code ? "code" : "summary");
    void navigate({
      to: "/pull-requests",
      search: {
        ...scope,
        ...ref,
        selectedEnvironmentId: scope.environmentId,
        selectedProjectId: scope.projectId,
        selectedHost: p.host,
        selectedUrl: p.url,
        involvement: "all",
        state: "all",
      },
    });
  };
  const prod = board.production?.find((d) => d.state === "SUCCESS");
  const last = board.production?.[0];
  const range = github.unshipped;
  const merges = new Map<number, string>();
  for (const c of range?.commits ?? []) for (const pr of c.pulls) merges.set(pr, c.title);
  const reviewHandoff = (id: string) => (
    <ReleaseBoardButton
      projects={[{ ...scope, title: github.title }]}
      startInProject
      focusItemId={id}
      onOpen={(threadId, environmentId) => {
        void navigate({ to: "/$environmentId/$threadId", params: { environmentId, threadId } });
      }}
    />
  );
  const extra = board.items.filter(
    (i) =>
      i.phase === "review" &&
      !i.pulls.some((p) => pulls.some((open) => open.url.toLowerCase() === p.url?.toLowerCase())),
  );
  const blocked = pulls.filter(
    (p) =>
      !p.isDraft ||
      p.checksState === "failing" ||
      p.mergeability === "conflicting" ||
      p.viewerReviewRequested,
  );
  return (
    <div className="space-y-7">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{gt("Needs your attention")}</h2>
        {github.open === null ? (
          <p role="status">{gt("Pull requests unavailable")}</p>
        ) : blocked.length === 0 && extra.length === 0 ? (
          <p className="text-muted-foreground">{gt("Nothing needs your attention.")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {blocked.map((p) => {
              const evidence = handoff(p.url)?.pulls.find(
                (link) => link.url?.toLowerCase() === p.url.toLowerCase(),
              );
              const failing = p.checksState === "failing";
              const handoffReview = handoff(p.url);
              const waiting =
                handoffReview?.phase === "review" && !handoffReview.approved && !p.isDraft;
              const confirmed = evidence?.evidence?.headChecksComplete
                ? evidence.evidence.headChecks?.filter((c) => failure(c.status) && !c.placeholder)
                : undefined;
              const reason = failing
                ? confirmed?.length
                  ? gt("{count} failed checks", { count: confirmed.length })
                  : gt("CI failed")
                : p.mergeability === "conflicting"
                  ? gt("Resolve merge conflicts")
                  : p.reviewDecision === "changes-requested"
                    ? gt("Changes requested")
                    : waiting
                      ? gt("Waiting for approval")
                      : p.viewerReviewRequested
                        ? gt("Ready for your review")
                        : p.reviewDecision === "review-required"
                          ? gt("Waiting for approval")
                          : p.checksState === "pending"
                            ? gt("CI running")
                            : p.reviewDecision === "approved"
                              ? gt("Approved")
                              : gt("Ready for your review");
              const failedUrl =
                coordinatorWebUrl(evidence?.checks.find((c) => failure(c.status) && c.url)?.url) ??
                (coordinatorWebUrl(p.url) ? p.url + "/checks" : null);
              return (
                <li key={p.url} className="flex flex-wrap items-center gap-3 p-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {p.title} <span className="text-muted-foreground">#{p.number}</span>
                    </div>
                    <div
                      className={
                        failing ? "text-xs text-destructive" : "text-xs text-muted-foreground"
                      }
                    >
                      {reason}
                    </div>
                  </div>
                  {failing && failedUrl ? (
                    <a
                      className="text-sm text-primary underline"
                      href={failedUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {gt("Open failed check")}
                    </a>
                  ) : waiting && handoffReview ? (
                    reviewHandoff(handoffReview.id)
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => review(p, p.reviewDecision !== "approved")}
                    >
                      {p.reviewDecision === "approved"
                        ? gt("Review and merge")
                        : gt("Review changes")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {extra.map((i) => (
          <div key={i.id} className="flex items-center justify-between rounded border p-3">
            <div>
              {i.title}
              <p className="text-xs text-muted-foreground">
                {i.pulls.length ? gt("Waiting for approval") : gt("No linked pull request")}
              </p>
            </div>
            {reviewHandoff(i.id)}
          </div>
        ))}
        {github.truncated && (
          <Link
            className="text-sm text-primary underline"
            to="/pull-requests"
            search={{ ...scope, state: "open", involvement: "all" }}
          >
            {gt("View all pull requests")}
          </Link>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{gt("What changed")}</h2>
        {chosen ? (
          <div className="space-y-3 rounded-lg border p-4">
            <select
              aria-label={gt("Pull request")}
              className="w-full rounded border bg-background p-2 text-sm"
              value={chosen.url}
              onChange={(e) => setSelected(e.target.value)}
            >
              {pulls.map((p) => (
                <option key={p.url} value={p.url}>
                  #{p.number} · {p.title}
                </option>
              ))}
            </select>
            <ChangeSummary
              key={chosen.url}
              scope={scope}
              pull={chosen}
              review={review}
              handoff={handoff(chosen.url)?.summary}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {github.open === null ? gt("Pull requests unavailable") : gt("No open pull requests")}
          </p>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{gt("What’s live?")}</h2>
        {prod ? (
          <div className="space-y-2 rounded-lg border p-4">
            <div className="font-medium">
              {gt("Deployed")} ·{" "}
              <a
                href={"https://" + prod.host + "/" + prod.repository + "/commit/" + prod.revision}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-primary underline"
              >
                {prod.revision.slice(0, 12)}
              </a>
            </div>
            <p className="text-xs text-muted-foreground">
              {prod.environment} · {new Date(prod.at).toLocaleString()}
            </p>
            {last && last !== prod && (
              <p className="text-xs">
                {gt("Latest deployment attempt")} · {last.state} · {last.revision.slice(0, 12)}
              </p>
            )}
            <h3 className="pt-2 text-sm font-medium">{gt("Merged since production")}</h3>
            {range ? (
              <>
                {Array.from(merges, ([n, title]) => (
                  <button
                    className="block text-left text-sm text-primary hover:underline"
                    key={n}
                    onClick={() =>
                      review(
                        {
                          host: prod.host,
                          repository: prod.repository,
                          number: n,
                          url: "https://" + prod.host + "/" + prod.repository + "/pull/" + n,
                        },
                        false,
                      )
                    }
                  >
                    #{n} · {title}
                  </button>
                ))}
                {range.commits
                  .filter((c) => !c.pulls.length)
                  .map((c) => (
                    <div key={c.sha} className="text-sm">
                      {gt("Direct commit")} · {c.title} · <code>{c.sha.slice(0, 8)}</code>
                    </div>
                  ))}
                {!range.commits.length && (
                  <p className="text-sm">{gt("Production is up to date.")}</p>
                )}
              </>
            ) : (
              <p className="text-sm">{gt("The production comparison is unavailable.")}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {board.production === null
              ? gt("Deployment status unavailable")
              : gt("No confirmed production deployment.")}
          </p>
        )}
      </section>
    </div>
  );
}
export function ProjectGitHubTab(scope: Scope) {
  const gt = useGT();
  const query = coordinatorBoardQuery({
    environmentId: scope.environmentId,
    input: { projectId: scope.projectId, github: true },
  });
  const result = useAtomValue(query);
  return (
    <main className="scrollbar-gutter-both h-full min-h-0 overflow-auto bg-background text-foreground">
      <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-7">
        <header className="flex items-center justify-between border-b pb-3">
          <div>
            <div className="text-sm text-muted-foreground">
              {result._tag === "Success" ? result.value.github?.title : null}
            </div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <PullRequestGlyph.pullRequest className="size-5" />
              {"GitHub"}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Link
              to="/pull-requests"
              className="text-sm text-primary hover:underline"
              search={{ ...scope, involvement: "all", state: "open" }}
            >
              {gt("Pull requests")}
            </Link>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={gt("Refresh")}
              onClick={() => appAtomRegistry.refresh(query)}
            >
              <RefreshCwIcon />
            </Button>
          </div>
        </header>
        {result._tag === "Success" && result.value.github ? (
          <ProjectChanges key={JSON.stringify(scope)} scope={scope} board={result.value} />
        ) : (
          <p role="status">
            {result._tag === "Initial" ? gt("Loading…") : gt("Project status unavailable")}
          </p>
        )}
      </div>
    </main>
  );
}

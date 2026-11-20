// @effect-diagnostics-next-line nodeBuiltinImport:off -- Revision tokens need a synchronous, stable SHA-256 digest.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Thread paths can use Windows or POSIX syntax on the same host.
import * as NodePath from "node:path";
import {
  coordinatorWebUrl,
  type BoardPhase,
  type CoordinatorChange,
  type FileOverlap,
  type OrchestrationV2ThreadShell,
  type ReviewAssets,
  type ThreadId,
} from "@t3tools/contracts";

export const emptyAssets: ReviewAssets = { preview: null, before: null, after: null };
export function revision(value: unknown) {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function handoffPulls(shell: OrchestrationV2ThreadShell) {
  const links = (shell.pullRequests ?? [])
    .filter((link) => link.source !== "stack-dismissed")
    .map((link) => ({
      host: link.host,
      repository: link.repository,
      number: link.number,
      url: link.url,
    }));
  const primary = shell.linkedPullRequest ?? shell.branchPullRequest;
  if (primary && coordinatorWebUrl(primary.url) && !links.some((link) => link.url === primary.url))
    links.push({
      host: new URL(primary.url).host,
      repository: primary.repository,
      number: primary.number,
      url: primary.url,
    });
  return links.map((link) => ({ ...link, url: coordinatorWebUrl(link.url) }));
}

export function releasePhase(
  changes: readonly (CoordinatorChange | null)[],
  assets: ReviewAssets,
  approved: boolean,
  scripts: readonly { status: string }[] = [],
): BoardPhase {
  if (changes.some((c) => c === null)) return "unavailable";
  const pulls = changes.flatMap((c) => (c ? [c] : []));
  if (
    pulls.some(
      (c) =>
        c.deploymentFailed || (c.state === "OPEN" && ["FAILURE", "ERROR"].includes(c.checks ?? "")),
    )
  )
    return "failed";
  if (pulls.length && pulls.every((c) => c.state === "MERGED"))
    return pulls.every((c) => c.deployedAt) ? "deployed" : "merged";
  if (pulls.some((c) => c.state === "CLOSED")) return "closed";
  if (pulls.some((c) => c.state === "OPEN" && (c.draft || c.changesRequested || c.conflict)))
    return "review";
  if (pulls.some((c) => c.state === "OPEN" && ["PENDING", "EXPECTED"].includes(c.checks ?? "")))
    return "ci";
  if (
    pulls.length &&
    pulls.every((c) => c.state === "MERGED" || (c.state === "OPEN" && c.checks === "SUCCESS"))
  ) {
    return !approved &&
      (assets.before || assets.after || assets.preview || pulls.some((c) => c.preview))
      ? "review"
      : "ready";
  }
  if (
    !pulls.length &&
    scripts.some((s) => s.status === "failed" || /^exit (?!0$)-?\d+$/.test(s.status))
  )
    return "failed";
  return approved && !pulls.length ? "ready" : "review";
}

export function findFileOverlaps(
  threads: readonly { id: ThreadId; title: string; root: string }[],
  edits: readonly { thread_id: string; path: string }[],
): FileOverlap[] {
  const byId = new Map(threads.map((t) => [String(t.id), t]));
  const byPath = new Map<string, Map<ThreadId, { id: ThreadId; title: string }>>();
  for (const edit of edits) {
    const thread = byId.get(edit.thread_id);
    if (!thread || !edit.path) continue;
    const pathApi = /^[a-z]:[\\/]/i.test(thread.root) ? NodePath.win32 : NodePath.posix;
    const path = pathApi
      .relative(thread.root, pathApi.resolve(thread.root, edit.path))
      .split(pathApi.sep)
      .join("/");
    if (!path || path === ".." || path.startsWith("../") || pathApi.isAbsolute(path)) continue;
    const owners = byPath.get(path) ?? new Map();
    owners.set(thread.id, { id: thread.id, title: thread.title });
    byPath.set(path, owners);
  }
  return Array.from(byPath, ([path, owners]) => ({ path, threads: Array.from(owners.values()) }))
    .filter((row) => row.threads.length > 1)
    .sort((a, b) => a.path.localeCompare(b.path));
}

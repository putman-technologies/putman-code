import { useAtomValue } from "@effect/atom-react";
import {
  summarizeCoordinatorStatuses,
  type CoordinatorStatus,
  type ScopedProjectRef,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { msg, useGT, useMessages } from "gt-react";
import { coordinatorStatusQuery } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { environmentShell } from "../../state/shell";

const presentation = {
  idle: [msg("Idle"), "bg-muted text-muted-foreground"],
  review: [msg("Needs review"), "bg-warning/15 text-warning-foreground"],
  ci: [msg("CI running"), "bg-info/15 text-info-foreground"],
  awaiting: [msg("Awaiting deploy"), "bg-muted text-muted-foreground"],
  deployed: [msg("Deployed"), "bg-success/15 text-success-foreground"],
  unavailable: [msg("Status unavailable"), "bg-muted text-muted-foreground"],
} as const;

const statusForMembers = Atom.family((members: readonly ScopedProjectRef[]) =>
  Atom.make((get) => {
    const states: Array<{ status: CoordinatorStatus; target: ScopedProjectRef }> = [];
    let loading = false;
    for (const target of members) {
      const { environmentId, projectId } = target;
      const config = get(serverEnvironment.configValueAtom(environmentId));
      if (!config?.environment.capabilities.coordinatorStatus) {
        if (members.length > 1) states.push({ status: "unavailable", target });
        continue;
      }
      if (get(environmentShell.statusAtom(environmentId)) !== "live") {
        states.push({ status: "unavailable", target });
        continue;
      }
      const answer = get(coordinatorStatusQuery({ environmentId, input: { projectId } }));
      if (answer._tag === "Initial") {
        loading = true;
        continue;
      }
      states.push({ status: answer._tag === "Success" ? answer.value : "unavailable", target });
    }
    const status = states.length ? summarizeCoordinatorStatuses(states.map((s) => s.status)) : null;
    return {
      status: loading ? null : status,
      target: states.find((s) => s.status === status)?.target ?? members[0],
    };
  }),
);

export function CoordinatorStatusBadge({ members }: { members: readonly ScopedProjectRef[] }) {
  const gt = useGT();
  const resolve = useMessages();
  const { status, target } = useAtomValue(statusForMembers(members));
  if (!target) return null;
  const colors = status ? presentation[status][1] : "bg-muted text-muted-foreground";
  const label = status ? resolve(presentation[status][0]) : "GitHub";
  const description = gt("Coordinator status: {status}", { status: label });
  return (
    <Link
      to="/pull-requests"
      search={{
        projectTab: "github",
        environmentId: target.environmentId,
        projectId: target.projectId,
        involvement: "all",
        state: "open",
      }}
      title={"GitHub · " + label}
      aria-label={"GitHub · " + description}
      className={`ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-3xs font-medium leading-tight ${colors}`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      <span className="sr-only">{description}</span>
      <span aria-hidden>{label}</span>
    </Link>
  );
}

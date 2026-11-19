import { useAtomValue } from "@effect/atom-react";
import {
  summarizeCoordinatorStatuses,
  type CoordinatorStatus,
  type ScopedProjectRef,
} from "@t3tools/contracts";
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
    const states: CoordinatorStatus[] = [];
    let loading = false;
    for (const { environmentId, projectId } of members) {
      const config = get(serverEnvironment.configValueAtom(environmentId));
      if (!config?.environment.capabilities.coordinatorStatus) {
        if (members.length > 1) states.push("unavailable");
        continue;
      }
      if (get(environmentShell.statusAtom(environmentId)) !== "live") {
        states.push("unavailable");
        continue;
      }
      const answer = get(coordinatorStatusQuery({ environmentId, input: { projectId } }));
      if (answer._tag === "Initial") {
        loading = true;
        continue;
      }
      states.push(answer._tag === "Success" ? answer.value : "unavailable");
    }
    if (loading) return null;
    return states.length ? summarizeCoordinatorStatuses(states) : null;
  }),
);

export function CoordinatorStatusBadge({ members }: { members: readonly ScopedProjectRef[] }) {
  const gt = useGT();
  const resolve = useMessages();
  const status = useAtomValue(statusForMembers(members));
  if (status === null) return null;
  const [message, colors] = presentation[status];
  const label = resolve(message);
  const description = gt("Coordinator status: {status}", { status: label });
  return (
    <span
      className={`ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-1.5 py-0.5 text-3xs font-medium leading-tight ${colors}`}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      <span className="sr-only">{description}</span>
      <span aria-hidden>{label}</span>
    </span>
  );
}

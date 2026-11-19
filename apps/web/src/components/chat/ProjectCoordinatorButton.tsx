import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ModelSelection, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CornerUpRightIcon, MessagesSquareIcon } from "lucide-react";
import { useRef, useState } from "react";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

export function ProjectCoordinatorButton(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  modelSelection: ModelSelection;
  completedRunId: RunId | null;
  onOpen: (threadId: ThreadId, environmentId: EnvironmentId) => void;
}) {
  const gt = useGT();
  const command = orchestrationEnvironment.projectCoordinator;
  const permitted = useAtomValue(command.permissionAtom(props.environmentId));
  const send = useOrchestrationCommand(command, { reportFailure: false });
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  if (!permitted) return null;
  const label = props.completedRunId ? gt("Send to Coordinator") : gt("Open Coordinator");
  const Icon = props.completedRunId ? CornerUpRightIcon : MessagesSquareIcon;
  const activate = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      const response = await send({
        environmentId: props.environmentId,
        input: props.completedRunId
          ? {
              action: "handoff",
              projectId: props.projectId,
              threadId: props.threadId,
              runId: props.completedRunId,
            }
          : { action: "open", projectId: props.projectId, modelSelection: props.modelSelection },
      });
      if (response._tag === "Success") {
        props.onOpen(response.value.threadId, props.environmentId);
      } else if (response._tag === "Failure") {
        const cause = squashAtomCommandFailure(response);
        toastManager.add({
          type: "error",
          title: label,
          description: cause instanceof Error ? cause.message : undefined,
        });
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <Button
      size="compact"
      variant="ghost-muted"
      disabled={busy}
      aria-busy={busy}
      aria-label={label}
      title={label}
      className="shrink-0 [-webkit-app-region:no-drag]"
      onClick={() => void activate()}
    >
      <Icon aria-hidden="true" className="size-3.5" />
      <span className="hidden lg:inline">{label}</span>
    </Button>
  );
}

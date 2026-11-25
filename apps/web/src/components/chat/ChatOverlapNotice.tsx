import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { coordinatorOverlapsQuery } from "../../state/projects";

export function ChatOverlapNotice({
  projectId,
  environmentId,
  threadId,
  onOpen,
}: {
  projectId: ProjectId;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onOpen: (threadId: ThreadId, environmentId: EnvironmentId) => void;
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

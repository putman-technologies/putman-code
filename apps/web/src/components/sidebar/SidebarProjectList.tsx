import type { ContextMenuSource, EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { SquarePenIcon } from "lucide-react";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { ProjectFavicon } from "../ProjectFavicon";
import { SidebarHeaderIconButton } from "./SidebarThreadHeader";

interface SidebarProjectListProps {
  projects: readonly SidebarProjectSnapshot[];
  selectedKeys: readonly string[];
  onSelect: (keys: readonly string[]) => void;
  onToggle: (key: string) => void;
  onContextMenu: (
    group: SidebarProjectSnapshot,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => void;
  onNewThread: (group: SidebarProjectSnapshot) => void;
  showEnvironments: boolean;
  primaryEnvironmentId: EnvironmentId | null;
  machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
}

export function SidebarProjectList(props: SidebarProjectListProps) {
  const gt = useGT();
  if (props.projects.length === 0) return null;

  return (
    <nav aria-label={gt("Projects")} className="mt-2 border-y border-sidebar-border py-2">
      <div className="mb-1 flex items-center justify-between gap-2 px-2">
        <h2 className="text-xs font-semibold text-sidebar-muted-foreground">{gt("Projects")}</h2>
        <button
          type="button"
          aria-pressed={props.selectedKeys.length === 0}
          className="cursor-pointer rounded px-1.5 py-0.5 text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover aria-pressed:font-semibold aria-pressed:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onClick={() => props.onSelect([])}
        >
          {gt("All projects")}
        </button>
      </div>
      <ul className="max-h-[32dvh] space-y-px overflow-y-auto overscroll-contain">
        {props.projects.map((project) => (
          <li key={project.projectKey} className="group/project flex items-center gap-0.5">
            <button
              type="button"
              aria-pressed={props.selectedKeys.includes(project.projectKey)}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-sidebar-foreground hover:bg-sidebar-row-hover aria-pressed:bg-sidebar-row-hover aria-pressed:font-semibold focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onContextMenu={(event) => {
                event.preventDefault();
                props.onContextMenu(
                  project,
                  { x: event.clientX, y: event.clientY },
                  contextMenuSourceOf(event),
                );
              }}
              onClick={(event) => {
                if (event.shiftKey) props.onToggle(project.projectKey);
                else props.onSelect([project.projectKey]);
              }}
            >
              <ProjectFavicon project={project} className="size-4 shrink-0" />
              <span className="truncate">{project.displayName}</span>
              {props.showEnvironments && (
                <ProjectEnvironmentBadge
                  group={project}
                  primaryEnvironmentId={props.primaryEnvironmentId}
                  machineByEnvironmentId={props.machineByEnvironmentId}
                />
              )}
            </button>
            <span className="opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 pointer-coarse:opacity-100">
              <SidebarHeaderIconButton
                label={gt("New thread in {project}", { project: project.displayName })}
                onClick={() => props.onNewThread(project)}
              >
                <SquarePenIcon aria-hidden />
              </SidebarHeaderIconButton>
            </span>
          </li>
        ))}
      </ul>
    </nav>
  );
}

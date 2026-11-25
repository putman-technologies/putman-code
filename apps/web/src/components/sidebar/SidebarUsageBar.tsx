import { useAtomValue } from "@effect/atom-react";
import { collectLimitAccounts, type LimitPoolWindow } from "@t3tools/shared/usageLimits";
import { useGT } from "gt-react";
import { useNowMinute } from "../../hooks/useNowMinute";
import { environmentPresentations } from "../../state/presentation";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { sidebarUsageWindows } from "./sidebarUsage";

function QuotaMeter({
  provider,
  window,
}: {
  provider: string;
  window: LimitPoolWindow | undefined;
}) {
  const gt = useGT();
  const percent = window?.remainingPercent;
  const value = percent === undefined ? "–" : gt("{percent}% left", { percent });
  const description = window
    ? `${provider} · ${window.label} · ${value}`
    : gt("{provider} usage unavailable", { provider });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className="min-w-0 rounded-sm focus-visible:outline-ring"
            role="img"
            tabIndex={0}
            aria-label={description}
          />
        }
      >
        <div className="flex items-baseline justify-between gap-1 whitespace-nowrap text-xs text-sidebar-foreground">
          <span className="font-medium">{provider}</span>
          <span className="tabular-nums text-sidebar-muted-foreground">{value}</span>
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-sidebar-foreground/15" aria-hidden>
          {percent !== undefined && (
            <div
              className="h-full rounded-full bg-sidebar-foreground/75"
              style={{ width: `${percent}%` }}
            />
          )}
        </div>
      </TooltipTrigger>
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
}

export function SidebarUsageBar() {
  const presentations = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const minute = useNowMinute();
  const connected = new Map(
    [...presentations].filter(([, entry]) => entry.connection.phase === "connected"),
  );
  const windows = sidebarUsageWindows(collectLimitAccounts(connected), Date.parse(minute + ":00Z"));
  return (
    <div className="grid grid-cols-2 gap-x-3 border-t border-sidebar-border px-2 pt-1.5 pb-1 group-data-[collapsible=icon]:hidden">
      <QuotaMeter provider="Codex" window={windows.codex} />
      <QuotaMeter provider="Claude" window={windows.claude} />
    </div>
  );
}

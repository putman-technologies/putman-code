import type { EnvironmentId } from "@t3tools/contracts";
import { formatCount, formatPercent, formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import { useGT, useLocale } from "gt-react";
import { InfoIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { useNowMinute } from "../../hooks/useNowMinute";
import { mergeAnsweredUsage, useEnvironmentUsage } from "../../state/usage";

export function DraftUsagePanel({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const locale = useLocale();
  const minute = useNowMinute();
  const window = makeWindow(30, new Date(minute + ":00Z"));
  const environment = useEnvironmentUsage(environmentId, window);
  const summary = environment?.summary;
  const merged = environment && summary ? mergeAnsweredUsage([environment]) : null;
  const scanning =
    environment?.isPending ||
    (environment?.isConnected && !environment.error && !summary) ||
    summary?.sources.some((source) => source.refreshing);
  const readable = summary?.sources.some(
    (source) => source.status === "ok" || source.status === "partial",
  );
  const incomplete = summary?.sources.some(
    (source) =>
      source.status === "partial" || source.status === "failed" || source.malformedRecords > 0,
  );
  const showFigures =
    environment?.isConnected &&
    !environment.error &&
    merged &&
    merged.contractMismatches.length === 0 &&
    readable &&
    (merged.records > 0 || (!scanning && !incomplete));
  const scope = environment?.label;
  const priceSource = gt("Uses provider-reported costs or model rates in USD.");
  const unpriced = merged?.costQuality.unpricedShare ?? 0;
  return (
    <section
      aria-label={gt("Usage")}
      className="mt-1 rounded-xl border border-border/70 bg-card/60 px-4 py-2.5 text-foreground"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-xs font-medium">{gt("Usage")}</span>
        <span className="truncate text-xs text-muted-foreground">
          {scope ? scope + " · " : ""}
          {gt("All projects")} · {gt("Last 30 days")}
        </span>
      </div>
      {showFigures && merged ? (
        <>
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
            <div>
              <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                {gt("Estimated API cost")}
                <Tooltip>
                  <TooltipTrigger aria-label={priceSource}>
                    <InfoIcon aria-hidden className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup>{priceSource}</TooltipPopup>
                </Tooltip>
              </dt>
              <dd aria-description={priceSource} className="font-semibold tabular-nums">
                {unpriced >= 1
                  ? gt("Unpriced")
                  : merged.costUsd > 0 && merged.costUsd < 0.01
                    ? gt("Under {amount}", { amount: formatUsd(0.01, locale) })
                    : formatUsd(merged.costUsd, locale)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{gt("Total tokens")}</dt>
              <dd className="font-semibold tabular-nums">
                {formatCount(merged.totalTokens, locale)}
              </dd>
            </div>
          </dl>
          <dl className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            {(
              [
                [gt("Uncached input"), merged.uncachedInputTokens],
                [gt("Cache read"), merged.cachedInputTokens],
                [gt("Cache write"), merged.cacheCreationTokens],
                [gt("Output"), merged.outputTokens],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex gap-1">
                <dt>{label}</dt>
                <dd className="tabular-nums">{formatCount(value, locale)}</dd>
              </div>
            ))}
          </dl>
          {unpriced > 0 && unpriced < 1 ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {gt("Estimate excludes {share} of records with unknown prices.", {
                share: formatPercent(unpriced),
              })}
            </p>
          ) : null}
        </>
      ) : null}
      {(!showFigures || scanning || incomplete) && (
        <p className="mt-1 text-xs text-muted-foreground">
          {environment?.error ??
            (environment && !environment.isConnected
              ? gt("This environment is not connected.")
              : scanning
                ? gt("Scanning…")
                : incomplete
                  ? gt("Usage data is incomplete.")
                  : gt("Usage unavailable"))}
        </p>
      )}
    </section>
  );
}

import { collectLimitPools, type LimitAccount } from "@t3tools/shared/usageLimits";

export function sidebarUsageWindows(accounts: readonly LimitAccount[], now: number) {
  // Ignore a reading after its reset. The provider's next snapshot supplies the new balance.
  const current = accounts.flatMap((account) => {
    if (account.driver !== "codex" && account.driver !== "claudeAgent") return [];
    const windows = account.limits.windows.filter((window) => {
      if (window.resetsAt && Date.parse(window.resetsAt) <= now) return false;
      return account.driver === "claudeAgent"
        ? window.kind === "weekly" && window.id === "seven_day"
        : window.kind === "session" || window.kind === "weekly" || window.kind === "monthly";
    });
    return windows.length ? [{ ...account, limits: { ...account.limits, windows } }] : [];
  });
  const pools = collectLimitPools(current, now);
  const codex = pools
    .find((pool) => pool.driver === "codex")
    ?.windows.toSorted((left, right) => left.remainingPercent - right.remainingPercent)[0];
  return { codex, claude: pools.find((pool) => pool.driver === "claudeAgent")?.windows[0] };
}

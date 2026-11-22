import { ProviderDriverKind, type ServerProviderUsageWindow } from "@t3tools/contracts";
import type { LimitAccount } from "@t3tools/shared/usageLimits";
import { expect, it } from "vite-plus/test";
import { sidebarUsageWindows } from "./sidebarUsage";

const now = Date.parse("2026-11-21T19:00:00Z");
const window = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  usedPercent: number,
): ServerProviderUsageWindow => ({ id, kind, label: id, usedPercent });
const account = (driver: string, windows: readonly ServerProviderUsageWindow[]): LimitAccount => ({
  driver: ProviderDriverKind.make(driver),
  key: driver,
  displayName: null,
  email: undefined,
  plan: undefined,
  accentColor: undefined,
  environments: [],
  sourceLabel: null,
  redeem: null,
  limits: { checkedAt: new Date(now).toISOString(), windows },
});

it("uses the limiting Codex allowance and only the all-model weekly Claude allowance", () => {
  const { codex, claude } = sidebarUsageWindows(
    [
      account("codex", [window("primary", "session", 20), window("secondary", "weekly", 75)]),
      account("claudeAgent", [
        window("five_hour", "session", 99),
        window("seven_day_sonnet", "weekly", 80),
        window("seven_day", "weekly", 24),
      ]),
    ],
    now,
  );
  expect(codex?.remainingPercent).toBe(25);
  expect(claude?.remainingPercent).toBe(76);
});

it("keeps exhaustion distinct from missing or expired readings and supports monthly Codex plans", () => {
  const accounts = [
    account("codex", [window("primary", "monthly", 100)]),
    account("claudeAgent", [
      { ...window("seven_day", "weekly", 67), resetsAt: new Date(now).toISOString() },
      window("five_hour", "session", 0),
    ]),
  ];
  expect(sidebarUsageWindows(accounts, now).codex?.remainingPercent).toBe(0);
  expect(sidebarUsageWindows(accounts, now).claude).toBeUndefined();
  expect(sidebarUsageWindows([], now).codex).toBeUndefined();
});

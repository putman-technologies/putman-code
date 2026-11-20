type Context = {
  readonly __typename: string;
  readonly name?: string;
  readonly context?: string;
  readonly conclusion?: string | null;
  readonly status?: string;
  readonly state?: string;
  readonly checkSuite?: { readonly app?: { readonly slug?: string | null } | null } | null;
  readonly targetUrl?: string | null;
};
type SetOfChecks = {
  readonly nodes?: readonly (Context | null)[] | null;
  readonly pageInfo: { readonly hasNextPage: boolean };
};
const outcome = (c: Context) => c.conclusion ?? c.state ?? c.status;
const failed = (c: Context) =>
  ["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE", "ACTION_REQUIRED", "STALE"].includes(
    outcome(c) ?? "",
  );
const key = (c: Context) =>
  [c.__typename, c.name ?? c.context, c.checkSuite?.app?.slug ?? ""].join("\n");
export function diagnoseCi(
  head: SetOfChecks | null | undefined,
  base: SetOfChecks | null | undefined,
  baseSha: string | null | undefined,
) {
  const bad = head?.nodes?.filter((c): c is Context => !!c && failed(c)) ?? [];
  if (!bad.length) return undefined;
  const baseline = base?.nodes?.filter((c): c is Context => !!c) ?? [];
  const unknown = {
    kind: "unknown" as const,
    detail: "Check identity or baseline results could not be verified.",
  };
  if (head?.pageInfo.hasNextPage) return unknown;
  if (bad.every((c) => outcome(c) === "STARTUP_FAILURE"))
    return { kind: "runner" as const, detail: "GitHub reported a check startup failure." };
  if (!baseSha || !base || base.pageInfo.hasNextPage) return unknown;
  const compared = bad.map((c) => {
    const matches = baseline.filter((b) => key(b) === key(c));
    if (matches.length !== 1 || bad.filter((b) => key(b) === key(c)).length !== 1) return "unknown";
    return failed(matches[0]!) ? "baseline" : outcome(matches[0]!) === "SUCCESS" ? "pr" : "unknown";
  });
  const detail =
    "Compared " +
    bad.map((c) => c.name ?? c.context).join(", ") +
    " with base " +
    baseSha.slice(0, 12) +
    ".";
  if (compared.every((c) => c === "baseline")) return { kind: "baseline" as const, detail };
  if (compared.every((c) => c === "pr")) return { kind: "pr" as const, detail };
  return { ...unknown, detail };
}

import {
  AssistantHost,
  PortableProfile,
  PortablePreferences,
  PortableSshRoute,
} from "@t3tools/contracts";
import { mergePortableProfile, sameProfileValue } from "@t3tools/shared/microsoftProfile";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  ensureClientSettingsHydrated,
  getClientSettings,
  persistClientSettingsUpdate,
} from "../hooks/useSettings";
import { getThemeSnapshot, setTheme, setAppearanceMode } from "../hooks/useTheme";
import { isKnownThemePreference } from "../themePalette";
import { readLocalStorageValue, writeLocalStorageValue } from "../hooks/useLocalStorage";
import type { MicrosoftProfileAction } from "@t3tools/contracts";

const snapshotKey = "putmancode:365:last-profile";
const hostKey = "putmancode:personal-assistant:ssh-host";
const cacheSchema = Schema.NullOr(PortableProfile);
const readPreferences = Schema.decodeUnknownSync(PortablePreferences);
const validHost = Schema.is(AssistantHost);
const validRoute = Schema.is(PortableSshRoute);
export const readProfileCache = () => readLocalStorageValue(snapshotKey, null, cacheSchema);
const setCache = (profile: PortableProfile | null) =>
  writeLocalStorageValue(snapshotKey, profile, null, cacheSchema);

function snapshot(cached: PortableProfile | null): PortableProfile {
  const ssh = new Map((cached?.ssh ?? []).map((t) => [t.alias, t]));
  const httpsRoutes = new Set(cached?.httpsRoutes);
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  for (const entry of catalog.entries.values()) {
    for (const route of [entry, ...(entry.alternateRoutes ?? [])]) {
      if (Option.isNone(route.profile)) continue;
      const profile = route.profile.value;
      if (profile._tag === "SshConnectionProfile" && validRoute(profile.target))
        ssh.set(profile.target.alias, profile.target);
      if (
        profile._tag === "BearerConnectionProfile" &&
        /^https:\/\/[\w.-]+(?::\d{1,5})?\/?$/.test(profile.httpBaseUrl)
      )
        httpsRoutes.add(profile.httpBaseUrl);
    }
  }
  const { theme, appearanceMode } = getThemeSnapshot();
  const assistantHost =
    readLocalStorageValue(hostKey, "", Schema.String) || cached?.assistantHost || "";
  return {
    version: 1,
    preferences: readPreferences(getClientSettings()),
    ssh: [...ssh.values()],
    httpsRoutes: [...httpsRoutes],
    theme: cached?.theme && !isKnownThemePreference(cached.theme) ? cached.theme : theme,
    appearance: appearanceMode,
    ...(validHost(assistantHost) ? { assistantHost } : {}),
  };
}

async function apply(profile: PortableProfile, prior: PortableProfile) {
  if (!sameProfileValue(prior.preferences, profile.preferences))
    await persistClientSettingsUpdate((settings) => ({ ...settings, ...profile.preferences }));
  if (profile.theme && profile.theme !== prior.theme && isKnownThemePreference(profile.theme))
    setTheme(profile.theme);
  if (
    profile.appearance &&
    (profile.appearance !== prior.appearance || profile.theme !== prior.theme)
  )
    setAppearanceMode(profile.appearance);
}

let queue: Promise<unknown> = Promise.resolve();
function serial<T>(operation: () => Promise<T>): Promise<T> {
  const next = queue.then(operation);
  queue = next.catch(() => undefined);
  return next;
}
function bridge(action: MicrosoftProfileAction) {
  const api = window.desktopBridge?.microsoftProfile;
  if (!api) throw new Error("Microsoft 365 sign-in requires the desktop app.");
  return api(action);
}
async function sync(fresh = false) {
  await ensureClientSettingsHydrated();
  const loaded = await bridge({ kind: "load" });
  const base = fresh ? null : readProfileCache();
  const local = snapshot(base);
  const merged = mergePortableProfile(local, base, loaded.profile);
  if (!sameProfileValue(loaded.profile, merged))
    await bridge({ kind: "save", profile: merged, revision: loaded.revision ?? null });
  await apply(merged, local);
  if (!sameProfileValue(base, merged)) setCache(merged);
}
export function syncMicrosoftProfile() {
  return serial(() => sync());
}
export function connectMicrosoftProfile() {
  return serial(async () => {
    const result = await bridge({ kind: "begin" });
    if (result.state !== "signedIn") throw new Error("Microsoft sign-in is unavailable.");
    setCache(null);
    await sync(true);
  });
}
export function disconnectMicrosoftProfile() {
  return serial(async () => {
    await bridge({ kind: "disconnect" });
    setCache(null);
  });
}
export const microsoftAccountStatus = () => bridge({ kind: "status" });

export function suggestedAssistantHost() {
  const profile = readProfileCache();
  const host = profile?.assistantHost ?? "";
  const route = profile?.ssh.find((t) => t.alias === host);
  if (route && (route.port === null || route.port === 22) && !route.hostname.includes(":"))
    return route.username ? route.username + "@" + route.hostname : route.hostname;
  return host;
}

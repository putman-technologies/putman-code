import { PortableProfile } from "@t3tools/contracts";
import {
  createMicrosoftProfileClient,
  microsoftRegistration,
  mergePortableProfile,
  sameProfileValue,
} from "@t3tools/shared/microsoftProfile";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { requireNativeModule } from "expo";
import * as SecureStore from "expo-secure-store";
import { File, Paths } from "expo-file-system";
import { environmentCatalog } from "../../connection/catalog";
import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { MOBILE_THEME_IDS, type MobileThemeId } from "../../lib/mobileTheme";

const key = "putmancode.365.session";
const readProfile = Schema.decodeUnknownSync(PortableProfile);
const cache = () => new File(Paths.document, "putmancode-settings-profile-v1.json");
export function readPhoneProfile(): PortableProfile | null {
  const file = cache();
  try {
    return file.exists ? readProfile(JSON.parse(file.textSync())) : null;
  } catch {
    return null;
  }
}
const call = createMicrosoftProfileClient({
  ...microsoftRegistration,
  authorize: (endpoint, client, scope) =>
    requireNativeModule<{
      authorize: (
        url: string,
        id: string,
        scope: string,
      ) => Promise<{ code: string; verifier: string; redirectUri: string }>;
    }>("PutmanCodeAccount").authorize(endpoint, client, scope),
  credentials: {
    read: () => SecureStore.getItemAsync(key),
    write: (token) => SecureStore.setItemAsync(key, token),
    clear: () => SecureStore.deleteItemAsync(key),
  },
});
export const phoneAccountStatus = () => call({ kind: "status" });
async function sync(fresh: boolean) {
  const stored = await call({ kind: "load" });
  const prev = fresh ? null : readPhoneProfile();
  const prefs = appAtomRegistry.get(mobilePreferencesAtom);
  if (!AsyncResult.isSuccess(prefs))
    throw new Error("Wait for phone settings to load and sync again.");
  const available = new Set(prev?.httpsRoutes ?? []);
  for (const row of appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries.values()) {
    for (const route of [row, ...(row.alternateRoutes ?? [])]) {
      if (Option.isSome(route.profile) && route.profile.value._tag === "BearerConnectionProfile") {
        const url = route.profile.value.httpBaseUrl;
        if (/^https:\/\/[\w.-]+(?::\d{1,5})?\/?$/.test(url)) available.add(url);
      }
    }
  }
  const local: PortableProfile = {
    ...prev,
    version: 1,
    preferences: { ...prev?.preferences, language: prefs.value.language ?? "en" },
    ssh: prev?.ssh ?? [],
    httpsRoutes: [...available],
    ...(prefs.value.themeId && (!prev?.theme || MOBILE_THEME_IDS.some((t) => t === prev.theme))
      ? { theme: prefs.value.themeId }
      : {}),
    ...(prefs.value.themeMode ? { appearance: prefs.value.themeMode } : {}),
  };
  const merged = mergePortableProfile(local, prev, stored.profile);
  if (!sameProfileValue(merged, stored.profile))
    await call({ kind: "save", profile: merged, revision: stored.revision ?? null });
  const themeId = MOBILE_THEME_IDS.find((t) => t === merged.theme);
  const changes = {
    ...(merged.preferences.language && merged.preferences.language !== prefs.value.language
      ? { language: merged.preferences.language }
      : {}),
    ...(themeId && themeId !== prefs.value.themeId ? { themeId: themeId as MobileThemeId } : {}),
    ...(merged.appearance && merged.appearance !== prefs.value.themeMode
      ? { themeMode: merged.appearance }
      : {}),
  };
  if (Object.keys(changes).length) appAtomRegistry.set(updateMobilePreferencesAtom, changes);
  if (!sameProfileValue(prev, merged)) cache().write(JSON.stringify(merged));
}
let queue: Promise<unknown> = Promise.resolve();
export function phoneProfileAction(kind: "begin" | "sync" | "disconnect") {
  const task = queue.then(async () => {
    if (kind === "disconnect") {
      await call({ kind });
      if (cache().exists) cache().delete();
      return;
    }
    if (kind === "begin") {
      await call({ kind });
      if (cache().exists) cache().delete();
    }
    await sync(kind === "begin");
  });
  queue = task.catch(() => undefined);
  return task;
}

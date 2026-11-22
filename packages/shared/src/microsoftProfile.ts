import { stableStringify } from "./relaySigning.ts";
import {
  PortableProfile,
  type MicrosoftProfileAction,
  type MicrosoftProfileResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const readProfile = Schema.decodeUnknownSync(PortableProfile);
const scope = "https://graph.microsoft.com/Files.ReadWrite.AppFolder offline_access";
const graph = "https://graph.microsoft.com/v1.0";
const fileName = /^settings-(\d{10})\.json$/;
const guid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const maxSize = 128 * 1024;

export interface ProfileCredentialStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

interface Options {
  tenant: string;
  client: string;
  credentials: ProfileCredentialStore;
  authorize: (
    endpoint: string,
    client: string,
    scope: string,
  ) => Promise<{ code: string; verifier: string; redirectUri: string }>;
  fetch?: typeof fetch;
  now?: () => number;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body))
    throw new Error("Invalid response from Microsoft.");
  return body as Record<string, unknown>;
}

function required(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value)
    throw new Error("Microsoft returned an incomplete response.");
  return value;
}

export const microsoftRegistration = {
  tenant: "2f772cb5-8db6-43ad-8bad-644e1524db9a",
  client: "726dc7ef-bcd4-4c2b-aa5c-21fa19745b81",
} as const;

export function createMicrosoftProfileClient(options: Options) {
  const http = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const authority = `https://login.microsoftonline.com/${options.tenant}/oauth2/v2.0`;
  let access: { token: string; expires: number } | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const signedIn = { state: "signedIn" } as const;

  async function tokenRequest(path: string, fields: Record<string, string>) {
    const res = await http(authority + path, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: options.client, ...fields }).toString(),
    });
    return { ok: res.ok, data: await json(res) };
  }

  async function accepted(data: Record<string, unknown>, refresh?: string) {
    const token = required(data, "access_token");
    await options.credentials.write(
      typeof data.refresh_token === "string"
        ? data.refresh_token
        : (refresh ?? required(data, "refresh_token")),
    );
    access = { token, expires: now() + Math.max(0, Number(data.expires_in) - 90) * 1000 };
    return token;
  }

  async function accessToken() {
    if (access && now() < access.expires) return access.token;
    const refresh = await options.credentials.read();
    if (!refresh) throw new Error("Sign in to Microsoft 365.");
    const { ok, data } = await tokenRequest("/token", {
      grant_type: "refresh_token",
      refresh_token: refresh,
      scope,
    });
    if (!ok) {
      if (data.error === "invalid_grant") {
        await options.credentials.clear();
        access = null;
      }
      throw new Error("Microsoft could not renew this session. Sign in again.");
    }
    return accepted(data, refresh);
  }

  async function api(url: string, token: string, init?: RequestInit) {
    if (!url.startsWith(graph + "/")) throw new Error("Invalid Microsoft Graph destination.");
    const res = await http(url, {
      ...init,
      headers: { ...init?.headers, Authorization: "Bearer " + token },
    });
    if (res.status === 409 || res.status === 412)
      throw new Error("Another device saved changes. Restore the latest settings and try again.");
    if (!res.ok)
      throw new Error(
        `Microsoft Graph returned HTTP ${res.status}. Check OneDrive access and try again.`,
      );
    return res;
  }

  async function folder(token: string) {
    return encodeURIComponent(
      required(await json(await api(graph + "/me/drive/special/approot?$select=id", token)), "id"),
    );
  }

  async function newest(folderId: string, token: string) {
    let url = graph + "/me/drive/items/" + folderId + "/children?$select=id,name,size&$top=200";
    let version = 0,
      item = "",
      size = 0;
    while (url) {
      const body = await json(await api(url, token));
      if (!Array.isArray(body.value))
        throw new Error("Could not read the OneDrive settings folder.");
      for (const entry of body.value) {
        const match = typeof entry?.name === "string" && fileName.exec(entry.name);
        if (match && Number(match[1]) > version) {
          version = Number(match[1]);
          item = required(entry, "id");
          size = Number(entry.size);
        }
      }
      url = typeof body["@odata.nextLink"] === "string" ? body["@odata.nextLink"] : "";
    }
    if (size > maxSize) throw new Error("The saved profile is too large to restore.");
    return { version, item };
  }

  async function run(action: MicrosoftProfileAction): Promise<MicrosoftProfileResult> {
    if (action.kind === "disconnect") {
      access = null;
      await options.credentials.clear();
      return { state: "signedOut" };
    }
    if (!guid.test(options.tenant) || !guid.test(options.client)) return { state: "unconfigured" };
    if (action.kind === "status")
      return { state: (await options.credentials.read()) ? "signedIn" : "signedOut" };
    if (action.kind === "begin") {
      const auth = await options.authorize(authority + "/authorize", options.client, scope);
      const { ok, data } = await tokenRequest("/token", {
        grant_type: "authorization_code",
        code: auth.code,
        code_verifier: auth.verifier,
        redirect_uri: auth.redirectUri,
        scope,
      });
      if (!ok)
        throw new Error(
          "Microsoft could not complete sign-in. Check the app registration and try again.",
        );
      await accepted(data);
      return signedIn;
    }
    const token = await accessToken();
    const folderId = await folder(token);
    const latest = await newest(folderId, token);
    if (action.kind === "load") {
      if (!latest.item) return signedIn;
      const content = await api(
        graph + "/me/drive/items/" + encodeURIComponent(latest.item) + "/content",
        token,
      );
      const body = await content.text();
      if (body.length > maxSize) throw new Error("The saved profile is too large to restore.");
      return {
        ...signedIn,
        revision: String(latest.version),
        profile: readProfile(JSON.parse(body)),
      };
    }
    if ((latest.version ? String(latest.version) : null) !== action.revision)
      throw new Error("Another device saved changes. Restore the latest settings and try again.");
    const version = latest.version + 1;
    const name = "settings-" + String(version).padStart(10, "0") + ".json";
    const body = JSON.stringify(readProfile(action.profile));
    if (body.length > maxSize) throw new Error("The settings profile is too large to save.");
    await api(
      graph +
        "/me/drive/items/" +
        folderId +
        ":/" +
        name +
        ":/content?@microsoft.graph.conflictBehavior=fail",
      token,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body },
    );
    return { ...signedIn, revision: String(version) };
  }
  return (action: MicrosoftProfileAction) => {
    const next = queue.then(() => run(action));
    queue = next.catch(() => undefined);
    return next;
  };
}

export const sameProfileValue = (left: unknown, right: unknown) =>
  stableStringify(left) === stableStringify(right);

/** Apply only fields that this device changed since it last read the profile. */
export function mergePortableProfile(
  local: PortableProfile,
  previous: PortableProfile | null,
  remote: PortableProfile | undefined,
): PortableProfile {
  if (!remote) return local;
  if (!previous) return remote;
  function field<T>(prior: T, here: T, there: T) {
    return sameProfileValue(prior, here) ? there : here;
  }
  const preferences = { ...remote.preferences };
  for (const key of Object.keys(local.preferences) as Array<keyof PortableProfile["preferences"]>) {
    const value = field(previous.preferences[key], local.preferences[key], remote.preferences[key]);
    if (value !== undefined) Object.assign(preferences, { [key]: value });
  }
  function routes<T>(
    old: readonly T[],
    here: readonly T[],
    there: readonly T[],
    key: (item: T) => string,
  ) {
    const prior = new Map(old.map((v) => [key(v), v]));
    const values = new Map(there.map((v) => [key(v), v]));
    for (const item of here) {
      if (!sameProfileValue(prior.get(key(item)), item)) values.set(key(item), item);
    }
    return [...values.values()];
  }
  const theme = field(previous.theme, local.theme, remote.theme);
  const appearance = field(previous.appearance, local.appearance, remote.appearance);
  const assistantHost = field(previous.assistantHost, local.assistantHost, remote.assistantHost);
  return {
    version: 1,
    preferences,
    ssh: routes(previous.ssh, local.ssh, remote.ssh, (route) => route.alias),
    httpsRoutes: routes(previous.httpsRoutes, local.httpsRoutes, remote.httpsRoutes, (url) => url),
    ...(theme ? { theme } : {}),
    ...(appearance ? { appearance } : {}),
    ...(assistantHost ? { assistantHost } : {}),
  };
}

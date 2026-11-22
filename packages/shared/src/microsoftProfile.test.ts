import { describe, expect, it, vi } from "vite-plus/test";
import {
  createMicrosoftProfileClient,
  mergePortableProfile,
  microsoftRegistration,
  sameProfileValue,
} from "./microsoftProfile.ts";
import type { PortableProfile } from "@t3tools/contracts";
const demo: PortableProfile = {
  version: 1,
  ssh: [],
  httpsRoutes: ["https://example.test:8443"],
  theme: "dark",
  preferences: { language: "en" },
};
function fixture() {
  const files = new Map<number, PortableProfile>();
  const requests: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const http: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/token"))
      return Response.json({
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_in: 3600,
      });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-access");
    if (url.includes("/special/approot")) return Response.json({ id: "appfolder" });
    if (url.includes("/children?"))
      return Response.json({
        value: [...files].map(([key]) => ({
          id: String(key),
          name: "settings-" + String(key).padStart(10, "0") + ".json",
          size: 200,
        })),
      });
    if (init?.method === "PUT") {
      expect(url).toContain("conflictBehavior=fail");
      const version = Number(/settings-(\d+)\.json/.exec(url)?.[1]);
      if (files.has(version)) return new Response("", { status: 409 });
      files.set(version, JSON.parse(String(init.body)));
      return Response.json({ id: String(version) });
    }
    return Response.json(files.get(Number(/items\/(\d+)\/content/.exec(url)?.[1])));
  };
  function device() {
    let refresh: string | null = null;
    const authorize = vi.fn(async (_endpoint: string, _id: string, _scope: string) => ({
      code: "test-code",
      verifier: "test-verifier",
      redirectUri: "http://localhost:1234",
    }));
    const client = createMicrosoftProfileClient({
      ...microsoftRegistration,
      authorize,
      fetch: http,
      credentials: {
        read: async () => refresh,
        write: async (value) => {
          refresh = value;
        },
        clear: async () => {
          refresh = null;
        },
      },
    });
    return { client, authorize };
  }
  return { files, requests, device };
}
describe("Microsoft 365 profile", () => {
  it("exchanges a PKCE code, saves a credential-free profile and restores it on a second device", async () => {
    const { files, requests, device } = fixture(),
      mac = device(),
      phone = device();
    await mac.client({ kind: "begin" });
    expect(mac.authorize.mock.calls[0]?.[2]).toBe(
      "https://graph.microsoft.com/Files.ReadWrite.AppFolder offline_access",
    );
    expect(String(requests[0]?.init?.body)).toContain("code_verifier=test-verifier");
    await mac.client({
      kind: "save",
      revision: null,
      profile: {
        ...demo,
        token: "do-not-sync",
        preferences: { ...demo.preferences, secret: "do-not-sync" },
      } as typeof demo,
    });
    expect(JSON.stringify(files.get(1))).not.toContain("do-not-sync");
    expect(await phone.client({ kind: "status" })).toEqual({ state: "signedOut" });
    await phone.client({ kind: "begin" });
    expect((await phone.client({ kind: "load" })).profile).toEqual(demo);
    await expect(phone.client({ kind: "save", revision: null, profile: demo })).rejects.toThrow(
      "Another device",
    );
    await mac.client({ kind: "disconnect" });
    expect((await mac.client({ kind: "status" })).state).toBe("signedOut");
    expect((await phone.client({ kind: "status" })).state).toBe("signedIn");
  });
  it("restores cloud preferences and retains an already-paired address on first sign-in", () => {
    const phone = { ...demo, theme: "other", httpsRoutes: ["https://phone.test"] };
    const restored = mergePortableProfile(phone, null, demo);
    expect(restored.theme).toBe(demo.theme);
    expect(restored.httpsRoutes).toEqual(["https://example.test:8443", "https://phone.test"]);
  });
  it("retains independently changed preferences and destinations", () => {
    const profile = mergePortableProfile(
      {
        ...demo,
        preferences: { language: "de" },
        ssh: [{ alias: "vps", hostname: "box", port: null, username: null }],
      },
      demo,
      { ...demo, preferences: { language: "en", confirmThreadArchive: true }, theme: "light" },
    );
    expect(profile.preferences).toEqual({ language: "de", confirmThreadArchive: true });
    expect(profile.theme).toBe("light");
    expect(profile.ssh[0]?.alias).toBe("vps");
    expect(
      sameProfileValue(profile, {
        ...profile,
        preferences: { confirmThreadArchive: true, language: "de" },
      }),
    ).toBe(true);
    expect(mergePortableProfile(demo, null, profile)).toEqual(profile);
  });
});

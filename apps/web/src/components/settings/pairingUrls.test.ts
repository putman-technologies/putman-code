import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  BearerConnectionProfile,
  BearerConnectionTarget,
  SshConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  remotePairingEndpoints,
  remotePairingOrigin,
  resolveDesktopPairingUrl,
  resolveHostedPairingUrl,
} from "./pairingUrls";

it("shares VPS endpoints and saved direct routes from an SSH-selected environment", () => {
  const environmentId = EnvironmentId.make("vps");
  const ssh = new SshConnectionTarget({ environmentId, connectionId: "ssh", label: "VPS" });
  const direct = (connectionId: string, httpBaseUrl: string) => ({
    target: new BearerConnectionTarget({ environmentId, connectionId, label: "VPS" }),
    profile: Option.some(
      new BearerConnectionProfile({
        environmentId,
        connectionId,
        label: "VPS",
        httpBaseUrl,
        wsBaseUrl: httpBaseUrl.replace(/^http/, "ws"),
      }),
    ),
  });
  const tailnet = "https://vps.example.ts.net";
  const lan = "http://192.168.1.9:3773";
  const environment = {
    entry: {
      target: ssh,
      profile: Option.none(),
      enabled: true,
      alternateRoutes: [
        direct("forward", "http://127.0.0.1:49100"),
        direct("saved", tailnet),
        direct("wrong", "https://old.example.com"),
      ],
    },
    refusedRouteIds: ["wrong"],
    serverConfig: {
      directEndpoints: [
        { kind: "lan" as const, httpBaseUrl: lan },
        { kind: "tailnet" as const, httpBaseUrl: tailnet + "/" },
      ],
    },
  };
  expect(remotePairingEndpoints(environment).map((e) => new URL(e.httpBaseUrl).origin)).toEqual([
    tailnet,
    lan,
  ]);
  expect(
    remotePairingEndpoints({ ...environment, serverConfig: null }).map(
      (e) => new URL(e.httpBaseUrl).origin,
    ),
  ).toEqual([tailnet]);
  expect(
    remotePairingEndpoints({
      ...environment,
      serverConfig: null,
      entry: { ...environment.entry, alternateRoutes: [] },
    }),
  ).toEqual([]);
});

it.each([
  "http://127.0.1.1:9191",
  "https://app.localhost.",
  "http://[::1]",
  "http://[::ffff:127.0.0.1]",
  "http://0.0.0.0:3773",
  "http://[::]",
  "ssh://orca@vps",
  "https://user:password@vps.example",
  "http://vps.example.com",
  "https://vps.example.com/pair#token=code",
])("excludes unusable remote pairing address %s", (value) => {
  expect(remotePairingOrigin(value)).toBeNull();
});

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://preview.t3.codes");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://preview.t3.codes/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });
});

import { buildHostedPairingUrl } from "../../hostedPairing";
import { setPairingTokenOnUrl } from "@t3tools/shared/remote";
import {
  connectionRouteId,
  connectionRoutes,
  routeHttpBaseUrl,
  type ConnectionCatalogEntry,
} from "@t3tools/client-runtime/connection";
import type { AdvertisedEndpoint, ServerDirectEndpoint } from "@t3tools/contracts";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import {
  isLocalLoopbackHost,
  isPrivateNetworkHost,
  isSharedAddressSpaceHost,
  isTailnetHost,
  isWildcardHost,
  normalizeHostname,
} from "@t3tools/shared/hostClassification";

/** A phone must be able to use the origin independently of the desktop's SSH tunnel. */
export function remotePairingOrigin(value: string): string | null {
  const url = URL.parse(value);
  if (!url || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    return null;
  const host = normalizeHostname(url.hostname);
  if (
    isLocalLoopbackHost(host) ||
    host.endsWith(".localhost") ||
    isWildcardHost(host) ||
    host.startsWith("::ffff:")
  )
    return null;
  return url.protocol === "https:" || (url.protocol === "http:" && isPrivateNetworkHost(host))
    ? url.origin
    : null;
}

export function remotePairingEndpoints(environment: {
  readonly entry: ConnectionCatalogEntry;
  readonly serverConfig: { readonly directEndpoints?: ReadonlyArray<ServerDirectEndpoint> } | null;
  readonly refusedRouteIds: ReadonlyArray<string>;
}): AdvertisedEndpoint[] {
  const endpoints = new Map<string, AdvertisedEndpoint>();
  const add = (address: string, source: "server" | "user", kind?: ServerDirectEndpoint["kind"]) => {
    const origin = remotePairingOrigin(address);
    if (!origin || endpoints.has(origin)) return;
    const { hostname, host } = new URL(origin);
    const privateRoute =
      kind === "tailnet" || isTailnetHost(hostname) || isSharedAddressSpaceHost(hostname);
    endpoints.set(
      origin,
      createAdvertisedEndpoint({
        id: origin,
        label: host,
        provider: { id: "remote", label: host, kind: "core", isAddon: false },
        httpBaseUrl: origin,
        source,
        reachability: privateRoute
          ? "private-network"
          : isPrivateNetworkHost(hostname)
            ? "lan"
            : "public",
      }),
    );
  };
  const reported = environment.serverConfig?.directEndpoints ?? [];
  // Prefer the VPS's tailnet address to a LAN that the phone may not share.
  for (const kind of ["tailnet", "lan"] as const) {
    for (const endpoint of reported) {
      if (endpoint.kind === kind) add(endpoint.httpBaseUrl, "server", kind);
    }
  }
  for (const route of connectionRoutes(environment.entry)) {
    if (
      route.target._tag !== "BearerConnectionTarget" ||
      environment.refusedRouteIds.includes(connectionRouteId(route.target))
    )
      continue;
    const address = routeHttpBaseUrl(route);
    if (address) add(address, "user");
  }
  return [...endpoints.values()];
}

export function resolveDesktopPairingUrl(endpointUrl: string, credential: string): string {
  const url = new URL(endpointUrl);
  url.pathname = "/pair";
  return setPairingTokenOnUrl(url, credential).toString();
}

export function resolveHostedPairingUrl(endpointUrl: string, credential: string): string | null {
  const url = new URL(endpointUrl);
  if (url.protocol !== "https:") {
    return null;
  }

  return buildHostedPairingUrl({
    host: endpointUrl,
    token: credential,
  });
}

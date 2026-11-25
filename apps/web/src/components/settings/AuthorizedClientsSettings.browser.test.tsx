import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type AdvertisedEndpoint,
  managedCapabilityDenial,
  type ManagedPolicySummary,
} from "@t3tools/contracts";
import { createAdvertisedEndpoint } from "@t3tools/shared/advertisedEndpoint";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { render, stubGlobal } from "../../../test/render";
import { AuthorizedClientsHeaderAction, PairingClientsList } from "./AuthorizedClientsSettings";

const localId = EnvironmentId.make("local");
const serviceId = EnvironmentId.make("service");

const state = vi.hoisted(() => ({
  primaryEnvironmentId: null as string | null,
  policies: new Map<string, unknown>(),
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => state.primaryEnvironmentId) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useServerConfigs: (() =>
    new Map(
      [...state.policies].map(([environmentId, managedPolicy]) => [
        environmentId,
        { managedPolicy },
      ]),
    )) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));

const remoteClientsOff: ManagedPolicySummary = {
  organization: "Example Corp",
  lockedSettings: [],
  limits: { clients: ["desktop"] },
};

function setup(policies: ReadonlyArray<readonly [EnvironmentId, ManagedPolicySummary]>) {
  state.primaryEnvironmentId = localId;
  state.policies = new Map(policies);
}

const renderHeader = (environmentId: EnvironmentId) =>
  render(
    <AuthorizedClientsHeaderAction
      environmentId={environmentId}
      onPairingLinkCreated={() => {}}
      clientSessions={null}
      isRevokingOtherClients={false}
      onRevokeOtherClients={() => {}}
      delegatableScopes={[]}
    />,
  );

describe("AuthorizedClientsHeaderAction", () => {
  const denial = managedCapabilityDenial(remoteClientsOff, "remoteClients")!;

  it("follows the selected service's policy, not the primary's", async () => {
    setup([[serviceId, remoteClientsOff]]);
    await using screen = await renderHeader(serviceId);

    await expect.element(screen.getByRole("group", { name: denial })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Create link" })).toBeDisabled();
  });

  it("leaves pairing open on an unmanaged service when the primary is managed", async () => {
    setup([[localId, remoteClientsOff]]);
    await using screen = await renderHeader(serviceId);

    await expect.element(screen.getByRole("button", { name: "Create link" })).toBeEnabled();
    expect(screen.getByRole("group", { name: denial }).query()).toBeNull();
  });
});

const serverAddress = "https://vps.example.ts.net";
const invitation = {
  id: "invite",
  subject: "phone",
  scopes: [],
  createdAt: "2025-01-01T00:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
};
const pairingUrl = serverAddress + "/pair#token=fixture-token";

const renderRemoteInvitation = (endpoints: AdvertisedEndpoint[]) =>
  render(
    <PairingClientsList
      servedByEnvironment={false}
      remoteEnvironmentId={serviceId}
      endpointUrl={null}
      defaultEndpointKey={null}
      endpoints={endpoints}
      isLoading={false}
      pairingLinks={[invitation]}
      sharedPairingLinkId={invitation.id}
      createdPairingCredentials={new Map([[invitation.id, "fixture-token"]])}
      clientSessions={[]}
      revokingPairingLinkId={null}
      revokingClientSessionId={null}
      onRevokePairingLink={() => {}}
      onRevokeClientSession={() => {}}
      canRevoke={true}
    />,
  );

describe("VPS pairing QR", () => {
  it("opens the new invitation with the VPS pairing URL and QR", async () => {
    const endpoint = createAdvertisedEndpoint({
      id: serverAddress,
      label: "VPS",
      provider: { id: "remote", label: "VPS", kind: "core", isAddon: false },
      httpBaseUrl: serverAddress,
      source: "server",
      reachability: "private-network",
    });
    await using screen = await renderRemoteInvitation([endpoint]);
    await expect.element(screen.getByRole("img", { name: /Pairing link/ })).toBeVisible();
    await expect.element(screen.getByText(pairingUrl, { exact: true })).toBeVisible();
  });

  it("verifies an SSH-only environment's address before building a QR", async () => {
    let reportedId = "other";
    const fetchDescriptor = vi.fn<typeof fetch>(async () =>
      Response.json({
        environmentId: reportedId,
        label: "Test VPS",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "1.0.0",
        orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
        capabilities: { repositoryIdentity: true },
      }),
    );
    using _fetch = stubGlobal("fetch", fetchDescriptor);
    await using screen = await renderRemoteInvitation([]);
    const qr = screen.getByRole("img", { name: /Pairing link/ });
    expect(qr.query()).toBeNull();
    await screen.getByRole("textbox").fill(serverAddress);
    await screen.getByRole("button", { name: "Show QR code" }).click();
    await expect.element(screen.getByRole("alert")).toBeVisible();
    expect(qr.query()).toBeNull();
    reportedId = serviceId;
    await screen.getByRole("button", { name: "Show QR code" }).click();
    await expect.element(qr).toBeVisible();
    await expect.element(screen.getByText(pairingUrl, { exact: true })).toBeVisible();
    expect(fetchDescriptor).toHaveBeenCalledTimes(2);
    for (const [input, init] of fetchDescriptor.mock.calls) {
      expect(input instanceof Request ? input.url : String(input)).toBe(
        serverAddress + "/.well-known/t3/environment",
      );
      expect(init?.credentials).toBe("omit");
    }
  });
});

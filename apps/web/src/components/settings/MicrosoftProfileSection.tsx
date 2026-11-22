import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  connectMicrosoftProfile,
  disconnectMicrosoftProfile,
  microsoftAccountStatus,
  syncMicrosoftProfile,
} from "../../account/profileSync";
import { Button } from "../ui/button";

export function MicrosoftProfileSection() {
  const gt = useGT();
  const [signedIn, setSignedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [synced, setSynced] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- read the account state from the native credential store.
  useEffect(() => {
    if (window.desktopBridge?.microsoftProfile)
      void microsoftAccountStatus()
        .then((s) => setSignedIn(s.state === "signedIn"))
        .catch(() => {});
  }, []);
  async function run(kind: "connect" | "sync" | "disconnect") {
    if (busy) return;
    setBusy(true);
    setError("");
    setSynced(false);
    try {
      if (kind === "connect") await connectMicrosoftProfile();
      else if (kind === "sync") await syncMicrosoftProfile();
      else await disconnectMicrosoftProfile();
      setSignedIn(kind !== "disconnect");
      setSynced(kind !== "disconnect");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      const status = await microsoftAccountStatus().catch(() => null);
      if (status) setSignedIn(status.state === "signedIn");
    }
    setBusy(false);
  }
  if (!window.desktopBridge?.microsoftProfile) return null;
  return (
    <section className="grid gap-2 rounded-lg border bg-card p-4">
      <h2 className="text-sm font-semibold">{gt("Microsoft 365")}</h2>
      <p className="text-sm text-muted-foreground">
        {gt(
          "Sync preferences and saved server addresses through your PutmanCode folder in OneDrive.",
        )}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {signedIn ? (
          <>
            <Button disabled={busy} size="sm" onClick={() => void run("sync")}>
              {gt("Sync now")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void run("disconnect")}
            >
              {gt("Sign out")}
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={busy} onClick={() => void run("connect")}>
            {gt("Sign in with Microsoft 365")}
          </Button>
        )}
        {busy && (
          <span role="status" className="text-sm">
            {gt("Connecting…")}
          </span>
        )}
        {synced && (
          <span role="status" className="text-sm">
            {gt("Settings synced")}
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}

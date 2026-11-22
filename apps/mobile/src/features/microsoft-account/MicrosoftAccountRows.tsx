import { useEffect, useState } from "react";
import { View } from "react-native";
import { useGT } from "gt-react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsRow } from "../settings/components/SettingsRow";
import { phoneAccountStatus, phoneProfileAction, readPhoneProfile } from "./account";
import { useAtomValue } from "@effect/atom-react";
import { mobilePreferencesAtom } from "../../state/preferences";

export function MicrosoftAccountRows() {
  const gt = useGT();
  useAtomValue(mobilePreferencesAtom);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- check this phone's secure account session when Settings opens.
  useEffect(() => {
    void phoneAccountStatus()
      .then((s) => setConnected(s.state === "signedIn"))
      .catch(() => {});
  }, []);
  async function act(kind: "begin" | "sync" | "disconnect") {
    if (busy) return;
    setBusy(true);
    setFeedback("");
    try {
      await phoneProfileAction(kind);
      setConnected(kind !== "disconnect");
      if (kind !== "disconnect") setFeedback(gt("Settings synced"));
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
      setConnected((await phoneAccountStatus()).state === "signedIn");
    }
    setBusy(false);
  }
  return (
    <View>
      <SettingsSection title={gt("Microsoft 365")}>
        <SettingsRow
          icon="arrow.clockwise"
          label={connected ? gt("Sync now") : gt("Sign in with Microsoft 365")}
          disabled={busy}
          onPress={() => void act(connected ? "sync" : "begin")}
        />
        {connected && (
          <SettingsRow
            icon="arrow.clockwise"
            label={gt("Sign out")}
            onPress={() => void act("disconnect")}
            disabled={busy}
          />
        )}
      </SettingsSection>
      {feedback ? (
        <Text accessibilityLiveRegion="polite" className="px-4 text-sm text-foreground-muted">
          {feedback}
        </Text>
      ) : null}
    </View>
  );
}

export function ProfileAddresses({ select }: { select: (url: string) => void }) {
  const routes = readPhoneProfile()?.httpsRoutes ?? [];
  return (
    <>
      {routes.map((url) => (
        <SettingsRow icon="arrow.clockwise" key={url} label={url} onPress={() => select(url)} />
      ))}
    </>
  );
}

import { useEffect } from "react";
import { useAppActive } from "../../lib/appState";
import { phoneProfileAction, readPhoneProfile } from "./account";

export function PhoneProfileSync() {
  const active = useAppActive();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- restore remote changes and save phone preferences while the app is in the foreground.
  useEffect(() => {
    if (!active) return;
    let busy = false;
    const refresh = () => {
      if (busy || !readPhoneProfile()) return;
      busy = true;
      void phoneProfileAction("sync")
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, 60000);
    return () => clearInterval(timer);
  }, [active]);
  return null;
}

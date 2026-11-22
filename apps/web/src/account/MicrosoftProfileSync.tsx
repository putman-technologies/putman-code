import { useEffect } from "react";
import { readProfileCache, syncMicrosoftProfile } from "./profileSync";

export function MicrosoftProfileSync() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- exchange changes while the signed-in desktop is open and when returning from another device.
  useEffect(() => {
    if (!window.desktopBridge?.microsoftProfile) return;
    let active = false;
    function refresh() {
      if (active || document.hidden || !readProfileCache()) return;
      active = true;
      void syncMicrosoftProfile()
        .catch(() => undefined)
        .finally(() => {
          active = false;
        });
    }
    const interval = setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    refresh();
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return null;
}

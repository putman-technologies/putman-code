import "~/index.css";
import { DEFAULT_CLIENT_SETTINGS, EnvironmentId } from "@t3tools/contracts";
import { readBrowserClientSettings, writeBrowserClientSettings } from "~/clientPersistenceStorage";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
  useClientSettings,
} from "~/hooks/useSettings";
import { RenameEnvironmentDialog } from "./RenameEnvironmentDialog";

const environmentId = EnvironmentId.make("vps");
function Row() {
  const [editing, setEditing] = useState(false);
  const displayName = useClientSettings(
    (settings) => settings.environmentDisplayNames[environmentId],
  );
  return (
    <>
      <button onClick={() => setEditing(true)}>{displayName ?? "putman-t3"}</button>
      {editing && (
        <RenameEnvironmentDialog
          environmentId={environmentId}
          hostLabel="putman-t3"
          displayName={displayName}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}

it("saves a device name across restart, leaves cancelled edits alone and restores the host name", async () => {
  const other = EnvironmentId.make("other");
  const original = readBrowserClientSettings() ?? DEFAULT_CLIENT_SETTINGS;
  using _restore = {
    [Symbol.dispose]: () => {
      writeBrowserClientSettings(original);
      __resetClientSettingsPersistenceForTests();
    },
  };
  writeBrowserClientSettings({
    ...DEFAULT_CLIENT_SETTINGS,
    environmentDisplayNames: { [other]: "Office" },
  });
  __resetClientSettingsPersistenceForTests();
  await ensureClientSettingsHydrated();
  {
    await using screen = await render(<Row />);
    await screen.getByRole("button", { name: "putman-t3" }).click();
    await page.getByRole("textbox", { name: "Display name" }).fill("  Sapphire VPS  ");
    await page.getByRole("button", { name: "Save" }).click();
    await expect.element(screen.getByRole("button", { name: "Sapphire VPS" })).toBeVisible();
  }
  __resetClientSettingsPersistenceForTests();
  await ensureClientSettingsHydrated();
  await using screen = await render(<Row />);
  const renamed = screen.getByRole("button", { name: "Sapphire VPS" });
  await renamed.click();
  const name = page.getByRole("textbox", { name: "Display name" });
  await name.fill("Cancel this");
  await page.getByRole("button", { name: "Cancel" }).click();
  await renamed.click();
  await expect.element(name).toHaveValue("Sapphire VPS");
  await name.fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect.element(screen.getByRole("button", { name: "putman-t3" })).toBeVisible();
  expect(readBrowserClientSettings()?.environmentDisplayNames).toEqual({ [other]: "Office" });
});

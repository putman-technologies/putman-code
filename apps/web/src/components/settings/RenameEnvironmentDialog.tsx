import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useState } from "react";
import { persistClientSettingsUpdate } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

export function RenameEnvironmentDialog({
  environmentId,
  hostLabel,
  displayName,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly hostLabel: string;
  readonly displayName?: string | undefined;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState(displayName ?? hostLabel);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const name = draft.trim();
  const override = name && name !== hostLabel ? name : undefined;

  function save() {
    if (saving || override === displayName) return;
    setSaving(true);
    setError(false);
    void persistClientSettingsUpdate((current) => {
      const environmentDisplayNames = { ...current.environmentDisplayNames };
      if (override) environmentDisplayNames[environmentId] = override;
      else delete environmentDisplayNames[environmentId];
      return { ...current, environmentDisplayNames };
    }).then(onClose, () => {
      setSaving(false);
      setError(true);
    });
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-sm">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              <T>Rename environment</T>
            </DialogTitle>
            <DialogDescription>
              {gt("Choose a name for this device. Leave it blank to use {name}.", {
                name: hostLabel,
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label={gt("Display name")}
              placeholder={hostLabel}
              value={draft}
              maxLength={80}
              disabled={saving}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
            {error && (
              <p role="alert" className="mt-2 text-sm text-destructive">
                <T>Could not save the environment name. Try again.</T>
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              <T>Cancel</T>
            </Button>
            <Button type="submit" disabled={saving || override === displayName}>
              <T>Save</T>
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

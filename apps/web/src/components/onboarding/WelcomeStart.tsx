import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ArrowRightIcon, MonitorIcon, ServerIcon } from "lucide-react";
import { useState } from "react";

import { APP_BASE_NAME } from "../../branding";
import { isElectron } from "../../env";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import { completeOnboarding } from "../../onboarding/firstRun";
import type { EnvironmentPresentation } from "../../state/environments";
import { PutmanCodeMark } from "../PutmanCodeMark";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { AddEnvironmentDialog } from "../settings/AddEnvironmentDialog";
import { MicrosoftProfileSection } from "../settings/MicrosoftProfileSection";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";

export function WelcomeStart({
  environments,
  catalogReady,
  primaryId,
  selectedId,
  onSelect,
  onContinue,
  onSkip,
}: {
  readonly environments: readonly EnvironmentPresentation[];
  readonly catalogReady: boolean;
  readonly primaryId: EnvironmentId | null;
  readonly selectedId: EnvironmentId | null;
  readonly onSelect: (id: EnvironmentId) => void;
  readonly onContinue: (id: EnvironmentId) => void;
  readonly onSkip: () => Promise<void>;
}) {
  const gt = useGT();
  const [adding, setAdding] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [skipping, setSkipping] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const selected =
    selectedId ??
    environments.find(
      (env) => env.environmentId === primaryId && env.connection.phase === "connected",
    )?.environmentId ??
    environments.find((env) => env.connection.phase === "connected")?.environmentId ??
    primaryId;
  const ready = environments.some(
    (env) => env.environmentId === selected && env.connection.phase === "connected",
  );

  async function skip() {
    if (skipping) return;
    setSkipping(true);
    setSaveError(false);
    try {
      await completeOnboarding();
      await onSkip();
    } catch {
      setSaveError(true);
      setSkipping(false);
    }
  }
  return (
    <SidebarInset
      {...workspaceAreaProps("home", 1, gt("Welcome"))}
      role="main"
      className="h-dvh min-h-0 overflow-hidden"
    >
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
        <div className="mx-auto grid w-full max-w-2xl gap-6 px-6 py-12 sm:py-20">
          <header>
            <PutmanCodeMark className="mb-4 size-11" />
            <h1 className="text-2xl font-semibold tracking-tight">
              {gt("Welcome to {app}", { app: APP_BASE_NAME })}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {gt(
                "Choose where your coding agent will run. Next, connect an agent and pick your projects.",
              )}
            </p>
          </header>
          <section aria-labelledby="welcome-computer" className="rounded-lg border bg-card p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="welcome-computer" className="text-sm font-semibold">
                {gt("Work environment")}
              </h2>
              <AddEnvironmentDialog
                open={adding}
                routeTarget={null}
                error={connectionError}
                savedEnvironments={environments.filter(
                  (env) => env.entry.target._tag !== "PrimaryConnectionTarget",
                )}
                onOpenChange={(open) => {
                  setAdding(open);
                  if (open) setConnectionError(null);
                }}
                onErrorChange={setConnectionError}
                onConnected={onSelect}
              />
            </div>
            <fieldset aria-labelledby="welcome-computer" className="mt-2 grid gap-1">
              {environments.map((env) => {
                const connected = env.connection.phase === "connected";
                const Icon = env.environmentId === primaryId ? MonitorIcon : ServerIcon;
                return (
                  <label
                    key={env.environmentId}
                    className="flex items-center gap-3 rounded-md px-2 py-2 text-sm has-checked:bg-accent"
                  >
                    <input
                      type="radio"
                      name="welcome-computer"
                      className="accent-primary"
                      checked={env.environmentId === selected}
                      disabled={!connected || skipping}
                      onChange={() => onSelect(env.environmentId)}
                    />
                    <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 break-words">{env.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {connected
                        ? gt("Connected")
                        : env.connection.phase === "connecting" ||
                            env.connection.phase === "reconnecting"
                          ? gt("Connecting…")
                          : gt("Unavailable")}
                    </span>
                  </label>
                );
              })}
              {environments.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  {catalogReady
                    ? gt("Add an environment to connect your first computer.")
                    : gt("Loading…")}
                </p>
              )}
            </fieldset>
          </section>
          <MicrosoftProfileSection optional />
          {saveError && (
            <p role="alert" className="text-sm text-destructive">
              {gt("Your settings could not be saved. Try again.")}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button variant="ghost-muted" disabled={skipping} onClick={() => void skip()}>
              {gt("Skip setup")}
            </Button>
            <Button
              disabled={!ready || skipping}
              onClick={() => {
                if (selected && ready) onContinue(selected);
              }}
            >
              {gt("Continue")}
              <ArrowRightIcon aria-hidden className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

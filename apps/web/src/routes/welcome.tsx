import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { WelcomeStart } from "../components/onboarding/WelcomeStart";
import { WelcomePage } from "../components/onboarding/WelcomePage";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);

export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  // A ChatGPT sign-in returns here with the computer it set up.
  const resumeEnvironmentId = hash.startsWith("agents:")
    ? Option.getOrUndefined(decodeEnvironmentId(hash.slice("agents:".length)))
    : undefined;
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments, isReady } = useEnvironments();
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const resumeKnown =
    resumeEnvironmentId !== undefined &&
    environments.some((environment) => environment.environmentId === resumeEnvironmentId);
  const isWelcomeRoute = useLocation({ select: (location) => location.pathname === "/welcome" });
  const [dismissed, setDismissed] = useState(false);
  const openNewThread = useNewThreadHandler();

  if (!isWelcomeRoute || dismissed) return <NoProjectsHero />;
  if (!isReady && resumeEnvironmentId !== undefined) return null;
  if (!resumeKnown || resumeEnvironmentId === undefined) {
    return (
      <WelcomeStart
        environments={environments}
        catalogReady={isReady}
        primaryId={primaryEnvironmentId}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onContinue={(id) => {
          setSelectedId(id);
          void navigate({ to: "/welcome", hash: `agents:${id}`, replace: true });
        }}
        onSkip={() => navigate({ to: "/", replace: true })}
      />
    );
  }
  return (
    <WelcomePage
      key={resumeEnvironmentId}
      environmentId={resumeEnvironmentId}
      onBack={() => {
        setSelectedId(resumeEnvironmentId);
        void navigate({ to: "/welcome", hash: "", replace: true });
      }}
      onDone={async (projectRef) => {
        setDismissed(true);
        if (projectRef !== undefined) {
          await openNewThread(projectRef, { replace: true }).catch(() =>
            navigate({ to: "/", replace: true }),
          );
          return;
        }
        await navigate({ to: "/", replace: true });
      }}
    />
  );
}

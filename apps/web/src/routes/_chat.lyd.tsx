import { createFileRoute, redirect } from "@tanstack/react-router";
import { isElectron } from "../env";
import LydPage from "../components/assistant/LydPage";

export const Route = createFileRoute("/_chat/lyd")({
  beforeLoad: () => {
    if (!isElectron) throw redirect({ to: "/", replace: true });
  },
  component: LydPage,
});

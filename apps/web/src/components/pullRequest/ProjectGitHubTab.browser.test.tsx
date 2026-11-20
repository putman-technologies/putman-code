import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { ProjectGitHubTab } from "./ProjectGitHubTab";

const scope = { environmentId: EnvironmentId.make("linux"), projectId: ProjectId.make("sapphire") };
const repo = "acme/sapphire";
const url = "https://github.com/" + repo + "/pull/19";
const data = Atom.make(
  AsyncResult.success({
    items: [],
    questions: [],
    overlaps: [],
    github: {
      title: "Sapphire",
      open: [
        {
          url,
          projectId: scope.projectId,
          host: "github.com",
          repository: repo,
          number: 19,
          title: "Invoice navigation",
          headBranch: "invoice-back",
          baseBranch: "main",
          checksState: "failing",
          viewerReviewRequested: true,
        },
      ],
      truncated: false,
      unshipped: {
        commits: [{ sha: "b".repeat(40), title: "New report", pulls: [21] }],
        files: [],
      },
    },
    production: [
      {
        state: "SUCCESS",
        environment: "production",
        repository: repo,
        host: "github.com",
        at: "2026-03-02T00:00:00Z",
        revision: "a".repeat(40),
      },
    ],
  }),
);
vi.mock("../../state/projects", () => ({ coordinatorBoardQuery: () => data }));
vi.mock("../../state/pullRequests", () => ({ pullRequestEnvironment: { detail: () => null } }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { body: "Keeps the invoice filter when going back." } }),
}));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { coordinatorBoardAction: { permissionAtom: () => Atom.make(true) } },
}));
const send = vi.fn();
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => send }));
it("keeps the failing PR, its review and the production revision distinguishable", async () => {
  await using screen = await render(<ProjectGitHubTab {...scope} />);
  await expect.element(screen.getByText("Needs your attention")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Open failed check" }))
    .toHaveAttribute("href", url + "/checks");
  await expect.element(screen.getByText("Keeps the invoice filter when going back.")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "aaaaaaaaaaaa" }))
    .toHaveAttribute("href", "https://github.com/" + repo + "/commit/" + "a".repeat(40));
  await expect.element(screen.getByRole("button", { name: "#21 · New report" })).toBeVisible();
  await screen.getByRole("button", { name: "Ask coordinator" }).click();
  await screen
    .getByRole("textbox", { name: "Question about this change" })
    .fill("Is the filter preserved?");
  send.mockResolvedValue({ _tag: "Failure" });
  await screen.getByRole("button", { name: "Send", exact: true }).click();
  await vi.waitFor(() =>
    expect(send).toHaveBeenCalledWith({
      environmentId: scope.environmentId,
      input: {
        type: "askPull",
        projectId: scope.projectId,
        url,
        question: "Is the filter preserved?",
        requestId: expect.any(String),
      },
    }),
  );
});

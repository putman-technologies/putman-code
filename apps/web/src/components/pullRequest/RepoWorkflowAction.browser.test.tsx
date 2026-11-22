import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { RepoWorkflowAction, type RepoWorkflowActionHandle } from "./RepoWorkflowAction";

const mock = vi.hoisted(() => ({ send: vi.fn(), toast: vi.fn() }));
vi.mock(
  import("~/state/pullRequests"),
  () => ({ pullRequestEnvironment: { workflowButton: {} } }) as never,
);
vi.mock(import("~/state/use-atom-command"), () => ({ useAtomCommand: () => mock.send }) as never);
vi.mock(import("../ui/toast"), () => ({ toastManager: { add: mock.toast } }) as never);

it("saves a repository workflow, waits for the merge and sends the chosen inputs once", async () => {
  const ref = createRef<RepoWorkflowActionHandle>();
  const repository = "test/workflow-button";
  localStorage.removeItem("putmancode:pr-workflow:github.com/" + repository);
  mock.send.mockImplementation(async ({ input }) => ({
    _tag: "Success",
    value:
      input.request.kind === "run"
        ? {
            kind: "dispatched",
            base: "main",
            url: "https://github.com/test/workflow-button/actions/runs/42",
          }
        : {
            kind: "list",
            base: "main",
            mergeSha: "abc123",
            workflows: [
              {
                id: 7,
                name: "Dry-run checks",
                file: "dry.yml",
                fields: [
                  {
                    name: "source_sha",
                    type: "string",
                    required: true,
                    description: "Commit",
                    options: [],
                  },
                ],
              },
            ],
          },
  }));
  const view = (merged: boolean) => (
    <>
      <button onClick={() => ref.current?.configure()}>Configure</button>
      <RepoWorkflowAction
        ref={ref}
        environmentId={EnvironmentId.make("env")}
        reference={{ projectId: ProjectId.make("project"), repository, number: 7 }}
        repositoryUrl={"https://github.com/" + repository}
        merged={merged}
      />
    </>
  );
  await using screen = await render(view(false));
  await page.getByRole("button", { name: "Configure", exact: true }).click();
  await page.getByRole("textbox", { name: "Button label" }).fill("Deploy staging");
  await page.getByRole("combobox", { name: "GitHub workflow" }).click();
  await page.getByRole("option", { name: /Dry-run checks/ }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const deploy = page.getByRole("button", { name: "Deploy staging", exact: true });
  await expect.element(deploy).toBeDisabled();
  await screen.rerender(view(true));
  await expect.element(deploy).toBeEnabled();
  expect(mock.send.mock.calls.some(([call]) => call.input.request.kind === "run")).toBe(false);
  await deploy.click();
  await expect.element(page.getByRole("textbox", { name: "source_sha" })).toHaveValue("abc123");
  await page.getByRole("button", { name: "Run workflow" }).click();
  await expect
    .poll(() =>
      mock.send.mock.calls
        .filter(([call]) => call.input.request.kind === "run")
        .map(([call]) => call.input.request),
    )
    .toEqual([{ kind: "run", workflowId: 7, inputs: { source_sha: "abc123" } }]);
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

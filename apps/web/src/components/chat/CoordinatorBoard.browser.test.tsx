import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { AtomRegistry, AsyncResult } from "effect/reactivity";
import { RegistryContext } from "@effect/atom-react";
import { coordinatorBoardQuery } from "../../state/projects";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type CoordinatorBoard,
  type CoordinatorBoardItem,
} from "@t3tools/contracts";
import { ReleaseBoardButton } from "./CoordinatorBoard";

const action = vi.fn();
const boards = new Map<ProjectId, CoordinatorBoard>();
vi.mock("../../state/projects", async () => {
  const { Atom } = await import("effect/reactivity");
  const byProject = Atom.family((id: ProjectId) =>
    Atom.make(() => AsyncResult.success(boards.get(id)!)),
  );
  return {
    coordinatorBoardQuery: ({ input }: { input: { projectId: ProjectId } }) =>
      byProject(input.projectId),
    coordinatorOverlapsQuery: vi.fn(),
  };
});
vi.mock("../../state/orchestration", async () => {
  const { Atom } = await import("effect/reactivity");
  const permissionAtom = () => Atom.make(true);
  return {
    orchestrationEnvironment: {
      coordinatorBoardAction: { permissionAtom },
      coordinatorRetry: { permissionAtom },
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => action }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: { refresh: vi.fn() } }));

describe("release board", () => {
  it("filters the inbox and sends only checked handoff revisions to the selected project's coordinator", async () => {
    const env = EnvironmentId.make("local"),
      one = ProjectId.make("one"),
      two = ProjectId.make("two");
    const coord = ThreadId.make("coord"),
      source = ThreadId.make("work");
    const row: CoordinatorBoardItem = {
      id: MessageId.make("handoff"),
      threadId: source,
      coordinatorId: coord,
      title: "Invoice detail",
      summary: "Opens the invoice in its own page.",
      at: "2026-01-01T00:00:00Z",
      files: [],
      scripts: [],
      phase: "ready",
      revision: "revision-a",
      approved: false,
      prepared: false,
      live: null,
      assets: { preview: null, before: null, after: null },
      pulls: [],
    };
    const empty = { items: [], questions: [], overlaps: [], production: [] };
    boards.set(one, {
      ...empty,
      production: [
        {
          repository: "acme/web",
          host: "github.com",
          environment: "production",
          revision: "bbbbbbbbbb",
          state: "SUCCESS",
          at: "2026-01-02T00:00:00Z",
          url: null,
        },
        {
          repository: "acme/web",
          host: "github.com",
          environment: "production",
          revision: "aaaaaaaaaa",
          state: "FAILURE",
          at: "2026-01-01T00:00:00Z",
          url: null,
        },
      ],
      items: [
        row,
        { ...row, id: MessageId.make("other"), title: "Payroll fix", revision: "revision-b" },
      ],
    });
    boards.set(two, {
      ...empty,
      questions: [{ id: source, kind: "question", title: "Which theme?" }],
    });
    action.mockResolvedValue(AsyncResult.success({ threadId: coord }));
    const onOpen = vi.fn();
    const registry = AtomRegistry.make();

    const button = (name: string) =>
      Array.from(document.querySelectorAll("button")).find((el) => el.textContent?.trim() === name);
    try {
      await using _screen = await render(
        <RegistryContext.Provider value={registry}>
          <ReleaseBoardButton
            projects={[
              { environmentId: env, projectId: one, title: "Accounts" },
              { environmentId: env, projectId: two, title: "Purchasing" },
            ]}
            onOpen={onOpen}
          />
        </RegistryContext.Provider>,
        { router: false },
      );
      await act(async () => button("Release board")!.click());
      expect(document.body.textContent).toContain("Which theme?");
      expect(document.body.textContent).not.toContain("Invoice detail");
      const select = document.querySelector("select")!;
      await act(async () => {
        select.value = Array.from(select.options).find((o) => o.text === "Accounts")!.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(document.body.textContent).toContain("Invoice detail");
      const oldPreview = "https://preview.example/old";
      const newPreview = "https://preview.example/new";
      const replaceRevision = (revision: string, preview: string) => {
        const board = boards.get(one)!;
        boards.set(one, {
          ...board,
          items: board.items.map((item) =>
            item.id === row.id ? { ...item, revision, assets: { ...item.assets, preview } } : item,
          ),
        });
        registry.refresh(coordinatorBoardQuery({ environmentId: env, input: { projectId: one } }));
      };
      await act(async () => replaceRevision("editing", oldPreview));
      await act(async () => button("Invoice detail")!.click());
      await act(async () => button("Edit preview links")!.click());
      expect(
        document.querySelector<HTMLInputElement>('input[value="' + oldPreview + '"]'),
      ).toBeTruthy();
      await act(async () => replaceRevision("reviewed", newPreview));
      expect(button("Save links")).toBeUndefined();
      await act(async () => button("Invoice detail")!.click());
      await act(async () => button("Edit preview links")!.click());
      expect(
        document.querySelector<HTMLInputElement>('input[value="' + newPreview + '"]'),
      ).toBeTruthy();
      const history = Array.from(document.querySelectorAll("details")).find((el) =>
        el.querySelector("summary")?.textContent?.includes("Deployment history"),
      );
      expect(history).toBeDefined();
      await act(async () => history!.querySelector("summary")!.click());
      expect(history!.open).toBe(true);
      expect(history!.textContent).toContain("aaaaaaaaaa");
      expect(history!.textContent).toContain("FAILURE");
      expect(button("Prepare release")!.disabled).toBe(true);
      await act(async () =>
        document.querySelector<HTMLInputElement>('input[aria-label="Invoice detail"]')!.click(),
      );
      const prepare = Array.from(document.querySelectorAll("button")).find((el) =>
        el.textContent?.includes("Prepare release"),
      );
      await act(async () => prepare!.click());
      expect(action).toHaveBeenCalledWith({
        environmentId: env,
        input: { type: "prepare", projectId: one, items: [{ id: row.id, revision: "reviewed" }] },
      });
      expect(onOpen).toHaveBeenCalledWith(coord, env);
    } finally {
      registry.dispose();
      boards.clear();
    }
  });
});

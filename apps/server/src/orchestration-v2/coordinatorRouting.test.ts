import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  MessageId,
  PlanId,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  coordinatorQuickModel,
  initialCoordinatorModel,
  isRoutineCoordinatorMessage,
} from "./coordinatorRouting.ts";

const project = ProjectId.make("a/b");
const message = {
  type: "message.dispatch",
  createdBy: "user",
  creationSource: "web",
  commandId: CommandId.make("input"),
  messageId: MessageId.make("msg"),
  threadId: ThreadId.make("coordinator-a%2Fb-0"),
  attachments: [],
  dispatchMode: { type: "start_immediately" },
  text: "Status?",
} as const;
const instanceId = ProviderInstanceId.make("coding");
const work = { instanceId, model: "gpt-6.2-astra" };
const catalog = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  version: null,
  checkedAt: "2026-11-19T20:00:00Z",
  slashCommands: [],
  skills: [],
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: ["gpt-6-luna", "gpt-6.2-astra", "claude-fable-5", "claude-haiku-5-5"].map((slug) => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
  })),
} satisfies ServerProvider;

describe("coordinator routing", () => {
  it("recognizes complete routine requests and keeps ambiguous or mixed requests on the work model", () => {
    for (const text of [
      "What's the status of PR #15?",
      "did CI pass?",
      "Recap this thread",
      "List open PRs",
      "Thanks!",
    ])
      expect(isRoutineCoordinatorMessage(project, { ...message, text })).toBe(true);
    for (const text of [
      "go ahead",
      "continue",
      "summarize and fix it",
      "status? then deploy",
      "status\nchange the site",
      "Deploy PR 15",
      "/plan",
      "Can you build a payroll feature?",
    ])
      expect(isRoutineCoordinatorMessage(project, { ...message, text })).toBe(false);
    expect(
      isRoutineCoordinatorMessage(project, {
        ...message,
        threadId: ThreadId.make("coordinator-a%2Fb-other"),
      }),
    ).toBe(false);
    expect(isRoutineCoordinatorMessage(project, { ...message, creationSource: "server" })).toBe(
      false,
    );
    expect(
      isRoutineCoordinatorMessage(project, {
        ...message,
        sourcePlanRef: { threadId: message.threadId, planId: PlanId.make("work") },
      }),
    ).toBe(false);
  });
  it("uses offered models on the same account and returns to the chosen work model", () => {
    expect(coordinatorQuickModel(catalog, work)).toEqual({ instanceId, model: "gpt-6-luna" });
    expect(coordinatorQuickModel(catalog, { instanceId, model: "claude-fable-5" })).toEqual({
      instanceId,
      model: "claude-haiku-5-5",
    });
    expect(initialCoordinatorModel(catalog, { instanceId, model: "gpt-6-luna" })).toEqual(work);
    expect(initialCoordinatorModel(catalog, { instanceId, model: "claude-sonnet-5" }).model).toBe(
      "claude-fable-5",
    );
    for (const unavailable of [
      undefined,
      { ...catalog, enabled: false },
      { ...catalog, models: [] },
      { ...catalog, instanceId: ProviderInstanceId.make("other") },
    ])
      expect(coordinatorQuickModel(unavailable, work)).toBeUndefined();
    for (const model of ["gpt-6-luna", "gpt-5-nano", "custom-model"])
      expect(coordinatorQuickModel(catalog, { instanceId, model })).toBeUndefined();
    const scoped = {
      ...catalog,
      workspaceSnapshots: [
        { cwd: "/one", checkedAt: catalog.checkedAt, models: [], skills: [], slashCommands: [] },
      ],
    };
    expect(coordinatorQuickModel(scoped, work, "/one")).toBeUndefined();
    expect(coordinatorQuickModel(scoped, work)).toBeUndefined();
  });
});

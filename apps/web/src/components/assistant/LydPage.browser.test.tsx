import type { AssistantAction, AssistantState } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import LydPage from "./LydPage";

it("connects a private SSH worker, defaults to silent tasks, and reopens the same conversation", async () => {
  let state: AssistantState = {
    running: true,
    phone: true,
    alwaysOn: true,
    older: false,
    tasks: [],
  };
  const actions: AssistantAction[] = [];
  const call = async (host: string, action: AssistantAction) => {
    expect(host).toBe("test-assistant");
    actions.push(action);
    if (action.kind === "send") {
      state = {
        ...state,
        tasks: [
          {
            seq: 1,
            id: action.id,
            prompt: action.prompt,
            status: "needs_input",
            answer: "Which region?",
            delivery: "off",
          },
        ],
      };
    }
    return state;
  };
  using _cleanup = {
    [Symbol.dispose]: () => localStorage.removeItem("putmancode:personal-assistant:ssh-host"),
  };
  {
    await using _screen = await render(<LydPage call={call} />);
    await page.getByRole("combobox", { name: "SSH host or alias" }).fill("test-assistant");
    await page.getByRole("button", { name: "Connect and install worker" }).click();
    await expect
      .element(page.getByRole("checkbox", { name: "Notify me when done" }))
      .not.toBeChecked();
    await expect.element(page.getByRole("main", { name: "Lyd" })).toBeVisible();
    await page.getByRole("button", { name: "Research a role" }).click();
    await expect
      .element(page.getByRole("textbox", { name: "Message" }))
      .toHaveValue("Help me research a job opportunity. Ask me for the role and company.");
    expect(actions.some((action) => action.kind === "send")).toBe(false);
    await page.getByRole("textbox", { name: "Message" }).fill("Find jobs");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.element(page.getByText("Which region?")).toBeVisible();
    expect(actions.find((a) => a.kind === "send")).toMatchObject({
      prompt: "Find jobs",
      notify: false,
    });
  }
  await using _screen = await render(<LydPage call={call} />);
  await expect.element(page.getByText("Needs your answer")).toBeVisible();
  await page.getByRole("button", { name: "Android notifications" }).click();
  await expect.element(page.getByRole("button", { name: "Send test and save" })).toBeDisabled();
});

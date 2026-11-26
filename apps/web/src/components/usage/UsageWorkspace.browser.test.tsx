import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { isAppModalPage, isSidebarUtilityPage } from "../sidebar/mainAppLocation";
import { UsagePage } from "./UsagePage";

it("opens the original Usage dashboard as a workspace page", async () => {
  expect(isAppModalPage("/usage")).toBe(false);
  expect(isSidebarUtilityPage("/usage")).toBe(true);
  await using screen = await render(<UsagePage />, { router: "/usage" });
  await expect.element(screen.getByRole("main", { name: "Usage" })).toBeVisible();
  await expect.element(screen.getByRole("heading", { name: "Usage" })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /Refresh (usage|limits)/ }))
    .toBeVisible();
  await expect.element(page.getByRole("dialog", { name: "Usage" })).not.toBeInTheDocument();
});

import { useLocation } from "@tanstack/react-router";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { SETTINGS_NAV_GROUPS, SETTINGS_SECTION_LABELS } from "./settingsSearch";

vi.mock("./useAvailableSettingsSearchItems", () => ({
  useAvailableSettingsSearchItems: () => [
    { id: "theme", title: "Theme", to: "/settings/appearance" },
    { id: "scheduled-tasks", title: "Scheduled tasks", to: "/settings/scheduled-tasks" },
  ],
}));

it("ignores composing keys in the search", async () => {
  await using screen = await render(
    <SidebarProvider defaultOpen>
      <SettingsSidebarNav pathname="/settings/general" />
    </SidebarProvider>,
    { router: "/settings/general" },
  );
  const search = page.getByRole("combobox", { name: "Search settings" });
  await search.fill("theme");
  await expect.element(page.getByRole("option", { name: /Theme/ })).toBeVisible();

  for (const composition of [
    { key: "Enter", isComposing: true, keyCode: 13 },
    { key: "Enter", isComposing: false, keyCode: 229 },
    { key: "Escape", isComposing: true, keyCode: 27 },
    { key: "Escape", isComposing: false, keyCode: 229 },
    { key: "ArrowDown", isComposing: true, keyCode: 40 },
    { key: "ArrowUp", isComposing: true, keyCode: 38 },
  ]) {
    const event = new KeyboardEvent("keydown", { ...composition, bubbles: true, cancelable: true });
    await act(() => search.element().dispatchEvent(event));
    expect(event.defaultPrevented, JSON.stringify(composition)).toBe(false);
    expect(screen.router?.state.location.pathname).toBe("/settings/general");
    await expect.element(search).toHaveValue("theme");
  }

  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/settings/appearance"),
  );
});

function RoutedSettingsNav() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return <SettingsSidebarNav pathname={pathname} />;
}

function renderNav(pathname = "/settings/general") {
  return render(
    <SidebarProvider defaultOpen>
      <RoutedSettingsNav />
    </SidebarProvider>,
    { router: pathname },
  );
}

it("opens search from the physical Slash and F keys on non-US layouts", async () => {
  await using _screen = await renderNav();
  const search = page.getByRole("combobox", { name: "Search settings" });

  for (const { init, opens } of [
    { init: { key: "/", code: "Digit7", shiftKey: true }, opens: true }, // German Shift+7
    { init: { key: ".", code: "Slash" }, opens: true }, // Russian Slash key
    { init: { key: "а", code: "KeyF", ctrlKey: true }, opens: true }, // Russian Ctrl+F
    { init: { key: "?", code: "Slash", shiftKey: true }, opens: false },
  ]) {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true });
    await act(() => document.body.dispatchEvent(event));
    expect(event.defaultPrevented, JSON.stringify(init)).toBe(opens);
    if (opens) await expect.element(search).toHaveFocus();
  }
});

it("moves Tab through every settings section", async () => {
  await page.viewport(1280, 800);
  await using _screen = await renderNav();
  await userEvent.click(page.getByRole("combobox", { name: "Search settings" }));

  const sections = SETTINGS_NAV_GROUPS.flatMap((group) => group.paths).map(
    (to) => SETTINGS_SECTION_LABELS[to],
  );
  const tabbed: string[] = [];
  for (let step = 0; step < sections.length; step += 1) {
    await userEvent.tab();
    const section = document.activeElement?.closest("[data-settings-section]");
    if (!section) break;
    tabbed.push(section.textContent ?? "");
  }
  expect(tabbed).toEqual(sections);
});

it.each([1280, 390])("names each group by a heading outside it at %ipx wide", async (width) => {
  await page.viewport(width, 800);
  await using _screen = await renderNav();

  for (const name of ["Agents", "Code", "Connections"]) {
    const heading = page.getByRole("heading", { name, level: 3 });
    await expect.element(heading).toBeInTheDocument();
    const group = page.getByRole("group", { name }).element();
    expect(group.getAttribute("aria-labelledby")).toBe(heading.element().id);
    expect(group.contains(heading.element()), `the ${name} heading is inside its group`).toBe(
      false,
    );
  }
  const groups = page.getByRole("group").elements();
  expect(groups).toHaveLength(SETTINGS_NAV_GROUPS.length);
  for (const group of groups) {
    const first = group.querySelector("[data-settings-section]")?.textContent;
    const heading = document.getElementById(group.getAttribute("aria-labelledby") ?? "");
    expect(heading?.tagName, `the group starting at ${first} has no heading`).toBe("H3");
  }
  expect(page.getByRole("tree").query()).toBeNull();
});

it("keeps everyday settings visible and opens an advanced search result directly", async () => {
  await page.viewport(1280, 800);
  await using screen = await renderNav();
  const advanced = page.getByRole("button", { name: "Advanced", exact: true });
  const scheduled = page.getByRole("button", { name: "Scheduled tasks", exact: true });
  await expect.element(advanced).toHaveAttribute("aria-expanded", "false");
  expect(scheduled.query()).toBeNull();
  for (const name of ["Projects", "Providers", "About", "Sharing & access"]) {
    await expect.element(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await advanced.click();
  await expect.element(scheduled).toBeVisible();
  await advanced.click();
  expect(scheduled.query()).toBeNull();
  const search = page.getByRole("combobox", { name: "Search settings" });
  await search.fill("scheduled");
  await userEvent.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/settings/scheduled-tasks"),
  );
  await expect.element(advanced).toHaveAttribute("aria-expanded", "true");
  await expect.element(scheduled).toHaveAttribute("aria-current", "page");
});

it("opens Advanced for a direct diagnostic link and highlights Maintenance", async () => {
  await page.viewport(390, 800);
  await using _screen = await renderNav("/settings/diagnostics");
  await expect
    .element(page.getByRole("button", { name: "Advanced", exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  await expect
    .element(page.getByRole("button", { name: "Maintenance", exact: true }))
    .toHaveAttribute("aria-current", "page");
});

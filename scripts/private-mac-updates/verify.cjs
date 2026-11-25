const { _electron } = require("playwright-core");
const path = require("node:path");

async function main() {
  const [bundle, initial, target] = process.argv.slice(2);
  const client = await _electron.launch({
    executablePath: path.join(bundle, "Contents/MacOS/PutmanCode"),
    env: { ...process.env },
    timeout: 90000,
  });
  const page = await client.firstWindow({ timeout: 90000 });
  await page.waitForFunction(() => typeof window.desktopBridge?.checkForUpdate === "function");
  const state = () => page.evaluate(() => window.desktopBridge.getUpdateState());
  console.log("Initial updater state", await state());
  const current = await client.evaluate(({ app }) => app.getVersion());
  if (current !== initial) throw new Error("Unexpected seed " + current);
  await page.evaluate(() => window.desktopBridge.checkForUpdate());
  await page.waitForFunction(async version =>
    (await window.desktopBridge.getUpdateState()).availableVersion === version,
    target, { timeout: 60000 });
  console.log("Available", await state());
  await page.evaluate(() => window.desktopBridge.downloadUpdate());
  await page.waitForFunction(async version =>
    (await window.desktopBridge.getUpdateState()).downloadedVersion === version,
    target, { timeout: 120000 });
  console.log("Downloaded", await state());
  const quit = client.waitForEvent("close", { timeout: 60000 });
  // The renderer may be disposed before the IPC promise resolves.
  await page.evaluate(version => { void window.desktopBridge.installUpdate(version); }, target);
  await quit;
}
main().catch(error => { console.error(error); process.exit(1); });

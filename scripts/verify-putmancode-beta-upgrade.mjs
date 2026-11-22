// Runs only on a fresh hosted desktop runner. Exercise the packaged updater on a loopback release feed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, createReadStream, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron } from "playwright-core";

const [executable, assetDir, expectedVersion] = process.argv.slice(2);
assert(executable && assetDir && expectedVersion);
const home = mkdtempSync(path.join(tmpdir(), "putmancode-upgrade-"));
const mac = process.platform === "darwin";
const feedName = mac ? "beta-mac.yml" : "beta.yml";
mkdirSync(path.join(home, "userdata"));
copyFileSync(
  path.resolve("scripts/fixtures/desktop-launch/statev2.sqlite"),
  path.join(home, "userdata", "statev2.sqlite"),
);
const requests = new Set();
let offerUpdate = false;
const server = createServer((req, res) => {
  const name = new URL(req.url, "http://localhost").pathname.slice(1);
  if (!name || name !== path.basename(name)) return res.writeHead(404).end();
  const file = path.join(assetDir, name);
  let size;
  try {
    size = statSync(file).size;
  } catch {
    return res.writeHead(404).end();
  }
  if (name === feedName && !offerUpdate) {
    return res.end(JSON.stringify({ version: "1.0.0-beta.0", path: "older", sha512: "older" }));
  }
  requests.add(name);
  res.writeHead(200, { "Content-Length": size });
  createReadStream(file)
    .on("error", () => res.destroy())
    .pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let app;
try {
  app = await _electron.launch({
    executablePath: executable,
    env: {
      ...process.env,
      PUTMANCODE_HOME: home,
      T3CODE_DISABLE_AUTO_UPDATE: "false",
      T3CODE_DESKTOP_MOCK_UPDATES: "true",
      T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: String(server.address().port),
      T3CODE_TELEMETRY_ENABLED: "false",
    },
    timeout: 90000,
  });
  const page = await app.firstWindow({ timeout: 90000 });
  const initial = await app.evaluate(({ app }) => ({
    version: app.getVersion(),
    resources: process.resourcesPath,
    pid: process.pid,
  }));
  assert.equal(initial.version, "1.0.0-beta.0");
  const bridgeState = () => page.evaluate(() => window.desktopBridge.getUpdateState());
  await page.getByText("Release launch check", { exact: true }).first().waitFor({ timeout: 90000 });
  const check = page.getByRole("button", { name: "Check for updates", exact: true });
  try {
    await check.waitFor({ timeout: 30000 });
  } catch (error) {
    console.error("Updater state:", JSON.stringify(await bridgeState()));
    console.error(
      "Buttons:",
      await page.getByRole("button").evaluateAll((nodes) =>
        nodes
          .map((n) => n.getAttribute("aria-label") || n.textContent)
          .filter(Boolean)
          .slice(-60),
      ),
    );
    throw error;
  }
  offerUpdate = true;
  await check.click({ timeout: 30000 });
  await page.waitForFunction(
    async (version) => (await window.desktopBridge.getUpdateState()).availableVersion === version,
    expectedVersion,
    { timeout: 90000 },
  );
  assert(requests.has(feedName), "The Update button must check the beta feed.");
  const downloaded = await page.evaluate(() => window.desktopBridge.downloadUpdate());
  assert(downloaded.completed, JSON.stringify(downloaded.state));
  assert.equal((await bridgeState()).downloadedVersion, expectedVersion);
  assert([...requests].some((name) => name.endsWith(mac ? ".zip" : ".exe")));
  const closed = app.waitForEvent("close", { timeout: 90000 });
  await page
    .evaluate((version) => window.desktopBridge.installUpdate(version), expectedVersion)
    .catch((error) => {
      if (!/closed|destroyed/i.test(String(error))) throw error;
    });
  await closed;
  app = undefined;
  const deadline = Date.now() + 150000;
  const asar = path.join(initial.resources, "app.asar");
  let installed;
  while (Date.now() < deadline) {
    try {
      // A separate process avoids caching the original ASAR header across replacement.
      installed = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'import {extractFile} from "@electron/asar";console.log(JSON.parse(extractFile(process.argv[1],"package.json")).version)',
          asar,
        ],
        { encoding: "utf8", cwd: import.meta.dirname, stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (installed === expectedVersion) break;
    } catch {
      /* The native installer is swapping the app. */
    }
    await delay(1000);
  }
  assert.equal(installed, expectedVersion, "Native update must replace the installed app");
  const processQuery = mac
    ? () =>
        execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" })
          .split("\n")
          .some((line) => {
            const match = /^\s*(\d+)\s+(.+)$/.exec(line);
            return (
              match &&
              Number(match[1]) !== initial.pid &&
              (match[2] === executable || match[2].startsWith(executable + " "))
            );
          })
    : () =>
        execFileSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "Get-Process PutmanCode -ErrorAction SilentlyContinue | Select-Object Id,Path | ConvertTo-Json -Compress",
          ],
          { encoding: "utf8" },
        ).trim();
  let running = false;
  while (!running && Date.now() < deadline) {
    try {
      const found = processQuery();
      running = mac
        ? found
        : []
            .concat(JSON.parse(found))
            .some(
              (p) => p.Id !== initial.pid && p.Path?.toLowerCase() === executable.toLowerCase(),
            );
    } catch {
      /* Waiting for the replacement process. */
    }
    if (!running) await delay(1000);
  }
  assert(running, "The new app must relaunch at the installed path");
  console.log(
    `Update button checked ${feedName}, downloaded, installed and relaunched ${initial.version} → ${installed}.`,
  );
} finally {
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  server.close();
}

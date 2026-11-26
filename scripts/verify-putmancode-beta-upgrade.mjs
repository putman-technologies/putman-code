// Runs only on a fresh hosted desktop runner. Exercise the packaged updater on a loopback release feed.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";
import { _electron } from "playwright-core";

const [executable, assetDir, expectedVersion, installedVersion] = process.argv.slice(2);
NodeAssert.ok(
  executable &&
    assetDir &&
    expectedVersion &&
    installedVersion &&
    expectedVersion !== installedVersion,
);
const existingProfile = process.env.PUTMANCODE_UPGRADE_FIXTURE;
if (existingProfile) {
  NodeAssert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  NodeAssert.ok(NodePath.resolve(existingProfile).startsWith(NodePath.resolve(process.env.RUNNER_TEMP) + NodePath.sep));
}
const home = existingProfile ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "putmancode-upgrade-"));
// oxlint-disable-next-line t3code/no-global-process-runtime -- This standalone installer test runs directly on the native CI host.
const mac = NodeOS.platform() === "darwin";
const feedName = mac ? "beta-mac.yml" : "beta.yml";
if (!existingProfile) {
  NodeFS.mkdirSync(NodePath.join(home, "userdata"));
  NodeFS.copyFileSync(
    NodePath.resolve("scripts/fixtures/desktop-launch/statev2.sqlite"),
    NodePath.join(home, "userdata", "statev2.sqlite"),
  );
} else {
  NodeAssert.ok(NodeFS.statSync(NodePath.join(home, "userdata", "statev2.sqlite")).isFile());
}
const requests = new Set();
let offerUpdate = false;
const server = NodeHttp.createServer((req, res) => {
  const name = new URL(req.url, "http://localhost").pathname.slice(1);
  if (!name || name !== NodePath.basename(name)) return res.writeHead(404).end();
  const file = NodePath.join(assetDir, name);
  let size;
  try {
    size = NodeFS.statSync(file).size;
  } catch {
    return res.writeHead(404).end();
  }
  if (name === feedName && !offerUpdate) {
    return res.end(JSON.stringify({ version: installedVersion, path: "older", sha512: "older" }));
  }
  requests.add(name);
  res.writeHead(200, { "Content-Length": size });
  NodeFS.createReadStream(file)
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
  NodeAssert.equal(initial.version, installedVersion);
  const bridgeState = () => page.evaluate(() => window.desktopBridge.getUpdateState());
  const thread = page.getByText("Release launch check", { exact: true }).first();
  const skipSetup = page.getByRole("button", { name: "Skip setup", exact: true });
  await thread.or(skipSetup).first().waitFor({ timeout: 90000 });
  if (await skipSetup.isVisible()) await skipSetup.click();
  await thread.waitFor({ timeout: 90000 });
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
  const offerDeadline = Date.now() + 90000;
  let offer = await bridgeState();
  while (
    offer.availableVersion !== expectedVersion &&
    offer.status !== "error" &&
    Date.now() < offerDeadline
  ) {
    await NodeTimersPromises.setTimeout(250);
    offer = await bridgeState();
  }
  NodeAssert.equal(offer.availableVersion, expectedVersion, JSON.stringify(offer));
  NodeAssert.ok(
    requests.has(feedName),
    `The Update button requested ${[...requests].join(", ")}; expected ${feedName}`,
  );
  // The sidebar can already be downloading when the bridge receives a second request.
  // Wait for the updater's confirmed version before asking the native installer to run.
  let download = (await page.evaluate(() => window.desktopBridge.downloadUpdate())).state;
  const downloadDeadline = Date.now() + 120000;
  while (
    download.status === "downloading" &&
    download.downloadedVersion !== expectedVersion &&
    Date.now() < downloadDeadline
  ) {
    await NodeTimersPromises.setTimeout(250);
    download = await bridgeState();
  }
  NodeAssert.equal(download.downloadedVersion, expectedVersion, JSON.stringify(download));
  NodeAssert.ok([...requests].some((name) => name.endsWith(mac ? ".zip" : ".exe")));
  const closed = app.waitForEvent("close", { timeout: 90000 });
  await page
    .evaluate((version) => window.desktopBridge.installUpdate(version), expectedVersion)
    .catch((error) => {
      if (!/closed|destroyed/i.test(String(error))) throw error;
    });
  await closed;
  app = undefined;
  const deadline = Date.now() + 150000;
  const asar = NodePath.join(initial.resources, "app.asar");
  let installed;
  while (Date.now() < deadline) {
    try {
      // A separate process avoids caching the original ASAR header across replacement.
      installed = NodeChildProcess.execFileSync(
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
    await NodeTimersPromises.setTimeout(1000);
  }
  NodeAssert.equal(installed, expectedVersion, "Native update must replace the installed app");
  const processQuery = mac
    ? () =>
        NodeChildProcess.execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" })
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
        NodeChildProcess.execFileSync(
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
    if (!running) await NodeTimersPromises.setTimeout(1000);
  }
  NodeAssert.ok(running, "The new app must relaunch at the installed path");
  console.log(
    `Update button checked ${feedName}, downloaded, installed and relaunched ${initial.version} → ${installed}.`,
  );
} finally {
  if (app) await app.close().catch(() => {});
  server.closeAllConnections();
  server.close();
}

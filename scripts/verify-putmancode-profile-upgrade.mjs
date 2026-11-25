// Two processes on a disposable CI machine exercise the same persisted profile.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _electron } from "playwright-core";

const [phase, executable, home, version] = process.argv.slice(2);
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.ok(["seed", "verify"].includes(phase));
assert.ok(path.isAbsolute(home) && home.startsWith(path.resolve(process.env.RUNNER_TEMP) + path.sep));
const state = path.join(home, "userdata");
const attachment = path.join(state, "attachments", "upgrade-fixture.txt");
const marker = { connectionId: "offline-fixture", environmentId: "upgrade-fixture", label: "Saved test VPS" };
const testCredential = "synthetic-upgrade-test-value";
const catalog = {
  schemaVersion: 1,
  targets: [{ _tag: "BearerConnectionTarget", ...marker }],
  profiles: [{ _tag: "BearerConnectionProfile", ...marker, httpBaseUrl: "https://example.invalid", wsBaseUrl: "wss://example.invalid" }],
  credentials: [{ connectionId: marker.connectionId, credential: { _tag: "BearerConnectionCredential", token: testCredential } }],
  remoteDpopTokens: [], disabledEnvironmentIds: [marker.environmentId],
};
if (phase === "seed") {
  fs.mkdirSync(path.dirname(attachment), {recursive: true});
  fs.copyFileSync("scripts/fixtures/desktop-launch/statev2.sqlite", path.join(state, "statev2.sqlite"), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(attachment, "test attachment", {flag:"wx"});
}
const app = await _electron.launch({ executablePath: executable, timeout: 90000,
  env: {...process.env, PUTMANCODE_HOME: home, T3CODE_DISABLE_AUTO_UPDATE: "true", T3CODE_TELEMETRY_ENABLED: "false"} });
try {
  const installed = await app.evaluate(({app}) => ({version: app.getVersion(), profile: app.getPath("userData")}));
  assert.equal(installed.version, version);
  const profileMarker = path.join(home, "expected-profile.txt");
  if (phase === "seed") fs.writeFileSync(profileMarker, installed.profile);
  else assert.equal(installed.profile, fs.readFileSync(profileMarker, "utf8"));
  const page = await app.firstWindow({timeout:90000});
  const thread = page.getByText("Release launch check", {exact: true}).first();
  const skip = page.getByRole("button", {name:"Skip setup",exact:true});
  await thread.or(skip).first().waitFor({timeout:90000});
  if (await skip.isVisible()) await skip.click();
  await thread.click({timeout:90000});
  await page.getByText("The release opens and shows this thread.", {exact:true}).first().waitFor({timeout:90000});
  if (phase === "seed") {
    await page.evaluate(async (catalog) => {
      const bridge = window.desktopBridge;
      const existing = await bridge.getClientSettings();
      await bridge.setClientSettings({...existing, sidebarWorkingShelfEnabled: false});
      if (!(await bridge.setConnectionCatalog(JSON.stringify(catalog)))) throw new Error("The previous version could not protect its connection catalog");
    },catalog);
  }
  const actual = await page.evaluate(async () => ({
    catalog: JSON.parse(await window.desktopBridge.getConnectionCatalog()),
    preference: (await window.desktopBridge.getClientSettings()).sidebarWorkingShelfEnabled,
  }));
  assert.equal(actual.preference,false);
  for (const field of ["targets","profiles","credentials","disabledEnvironmentIds"]) {
    assert.deepEqual(actual.catalog[field],catalog[field]);
  }
  const envelope = JSON.parse(fs.readFileSync(path.join(state,"connection-catalog.json"),"utf8"));
  assert.ok(envelope.encryptedCatalog && !JSON.stringify(envelope).includes(testCredential));
  assert.equal(fs.readFileSync(attachment,"utf8"),"test attachment");
  console.log(phase, version, "opened the saved chat and read its attachment, preference, saved connection and protected credential");
} finally { await app.close(); }

import serverPackageJson from "../../../server/package.json" with { type: "json" };
import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CLI_RELEASE_BASE_URL_ENV } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { resolveDesktopSshCliRunner } from "./DesktopSshEnvironment.ts";

const packagedEnvironment = DesktopEnvironment.DesktopEnvironment.pipe(
  Effect.provide(
    DesktopEnvironment.layer({
      dirname: "/Applications/PutmanCode.app/Contents/Resources/app.asar/dist-electron",
      homeDirectory: "/Users/alice",
      platform: "darwin",
      processArch: "arm64",
      appVersion: "0.0.1",
      appPath: "/Applications/PutmanCode.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/PutmanCode.app/Contents/Resources",
      runningUnderArm64Translation: false,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(NodeServices.layer, NodePath.layerPosix, DesktopConfig.layerTest({})),
      ),
    ),
  ),
);

describe("resolveDesktopSshCliRunner", () => {
  it.effect("uses the desktop beta's Linux companion for a default SSH connection", () =>
    Effect.gen(function* () {
      const runner = resolveDesktopSshCliRunner(yield* packagedEnvironment, {});
      assert.deepStrictEqual(runner.linuxArchive, {
        version: serverPackageJson.version,
        releaseBaseUrl: "https://github.com/putman-technologies/putman-code/releases/download",
      });
    }),
  );

  it.effect("downloads the remote runner from the release mirror", () =>
    Effect.gen(function* () {
      const environment = yield* packagedEnvironment;

      const runner = resolveDesktopSshCliRunner(environment, {
        [CLI_RELEASE_BASE_URL_ENV]: "https://mirror.example.com/t3code",
      });

      assert.deepStrictEqual(runner, {
        archiveVersion: "0.1.10",
        releaseBaseUrl: "https://mirror.example.com/t3code",
      });
    }),
  );
});

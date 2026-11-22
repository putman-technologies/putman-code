import { MicrosoftProfileAction, MicrosoftProfileResult } from "@t3tools/contracts";
import {
  createMicrosoftProfileClient,
  microsoftRegistration,
} from "@t3tools/shared/microsoftProfile";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FileSystem from "effect/FileSystem";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronSafeStorage from "../../electron/ElectronSafeStorage.ts";
import { MICROSOFT_PROFILE_CHANNEL } from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";
import { microsoftLoopback } from "../../account/MicrosoftLoopback.ts";

class MicrosoftProfileError extends Schema.TaggedError<MicrosoftProfileError>()(
  "MicrosoftProfileError",
  { message: Schema.String },
) {}
let client: ReturnType<typeof createMicrosoftProfileClient> | undefined;

export const microsoftProfile = makeIpcMethod({
  channel: MICROSOFT_PROFILE_CHANNEL,
  payload: MicrosoftProfileAction,
  result: MicrosoftProfileResult,
  handler: Effect.fn("desktop.ipc.microsoftProfile")(function* (action) {
    if (!client) {
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      const env = yield* DesktopEnvironment.DesktopEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const vault = yield* ElectronSafeStorage.ElectronSafeStorage;
      const shell = yield* ElectronShell.ElectronShell;
      const path = env.path.join(env.stateDir, "microsoft-profile-session.bin");
      client = createMicrosoftProfileClient({
        ...microsoftRegistration,
        authorize: (endpoint, id, scope) =>
          microsoftLoopback(endpoint, id, scope, (url) => run(shell.openExternal(url))),
        credentials: {
          read: () =>
            run(
              Effect.gen(function* () {
                if (!(yield* fs.exists(path))) return null;
                return yield* vault.decryptString(yield* fs.readFile(path));
              }),
            ),
          write: (value) =>
            run(
              Effect.gen(function* () {
                if (!(yield* vault.isEncryptionAvailable))
                  throw new Error("Unlock secure storage before signing in.");
                const encrypted = yield* vault.encryptString(value);
                yield* fs.makeDirectory(env.stateDir, { recursive: true });
                yield* fs.writeFile(path + ".tmp", encrypted, { mode: 0o600 });
                yield* fs.rename(path + ".tmp", path);
              }),
            ),
          clear: () => run(fs.remove(path, { force: true })),
        },
      });
    }
    const account = client;
    return yield* Effect.tryPromise({
      try: () => account(action),
      catch: (cause) =>
        new MicrosoftProfileError({
          message: cause instanceof Error ? cause.message : "Microsoft 365 request failed.",
        }),
    });
  }),
});

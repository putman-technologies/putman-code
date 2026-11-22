import { AssistantAction, AssistantRequest, AssistantState } from "@t3tools/contracts";
import { runSshCommand } from "@t3tools/ssh/command";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { PERSONAL_ASSISTANT_CHANNEL } from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

const encodeAction = Schema.encodeEffect(Schema.fromJsonString(AssistantAction));
const decodeState = Schema.decodeEffect(Schema.fromJsonString(AssistantState));
const worker = '"$HOME/.local/share/putmancode-assistant/worker.py"';
// Only the bundled worker crosses stdin here. User messages and keys use the separate JSON request.
const install = [
  "set -eu",
  "umask 077",
  'dir="$HOME/.local/share/putmancode-assistant"',
  'mkdir -p "$dir"',
  'tmp=$(mktemp "$dir/.install.XXXXXX")',
  "trap 'rm -f \"$tmp\"' EXIT",
  'cat > "$tmp"',
  `mv "$tmp" ${worker}`,
].join("; ");

export const personalAssistant = makeIpcMethod({
  channel: PERSONAL_ASSISTANT_CHANNEL,
  payload: AssistantRequest,
  result: AssistantState,
  handler: Effect.fn("desktop.ipc.personalAssistant")(function* ({ host, action }) {
    const target = { alias: host, hostname: host, username: null, port: null };
    if (action.kind === "connect") {
      const env = yield* DesktopEnvironment.DesktopEnvironment;
      const fs = yield* FileSystem.FileSystem;
      const path = env.isPackaged
        ? env.path.join(env.resourcesPath, "assistant", "worker.py")
        : env.path.join(env.rootDir, "apps", "desktop", "resources", "assistant", "worker.py");
      const source = yield* fs.readFileString(path);
      yield* runSshCommand(target, { remoteCommandArgs: [install], stdin: source });
    }
    const reply = yield* runSshCommand(target, {
      remoteCommandArgs: [`python3 ${worker} request`],
      stdin: yield* encodeAction(action),
    });
    return yield* decodeState(reply.stdout.trim());
  }),
});

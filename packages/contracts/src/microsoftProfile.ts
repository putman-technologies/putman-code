import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ClientSettingsPatch } from "./settings.ts";
import { PortSchema } from "./baseSchemas.ts";
import { AssistantHost } from "./personalAssistant.ts";

const host = Schema.String.check(
  Schema.isMaxLength(253),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/),
);
export const PortableSshRoute = Schema.Struct({
  alias: AssistantHost,
  hostname: host,
  username: Schema.NullOr(
    Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/)),
  ),
  port: Schema.NullOr(PortSchema),
});
export type PortableSshRoute = typeof PortableSshRoute.Type;
export const portablePreferenceKeys = [
  "language",
  "appearanceContrast",
  "chatWidth",
  "diffColorScheme",
  "diffLayout",
  "diffIgnoreWhitespace",
  "confirmThreadArchive",
  "confirmThreadDelete",
  "confirmTerminalClose",
  "effortDisplay",
  "inAppNotificationsEnabled",
  "environmentDisplayNames",
  "toolCallVisibility",
  "screenReaderAnnouncements",
] as const;
export const PortablePreferences = ClientSettingsPatch.mapFields(
  Struct.pick(portablePreferenceKeys),
);
export const PortableProfile = Schema.Struct({
  version: Schema.Literal(1),
  preferences: PortablePreferences,
  theme: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(150))),
  appearance: Schema.optionalKey(Schema.Literals(["system", "light", "dark"])),
  assistantHost: Schema.optionalKey(AssistantHost),
  ssh: Schema.Array(PortableSshRoute).check(Schema.isMaxLength(100)),
  httpsRoutes: Schema.Array(
    Schema.String.check(
      Schema.isMaxLength(400),
      Schema.isPattern(/^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]{1,5})?\/?$/),
    ),
  ).check(Schema.isMaxLength(100)),
});
export type PortableProfile = typeof PortableProfile.Type;
export const MicrosoftProfileAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("status") }),
  Schema.Struct({ kind: Schema.Literal("begin") }),
  Schema.Struct({ kind: Schema.Literal("disconnect") }),
  Schema.Struct({ kind: Schema.Literal("load") }),
  Schema.Struct({
    kind: Schema.Literal("save"),
    profile: PortableProfile,
    revision: Schema.NullOr(Schema.String),
  }),
]);
export type MicrosoftProfileAction = typeof MicrosoftProfileAction.Type;
export const MicrosoftProfileResult = Schema.Struct({
  state: Schema.Literals(["unconfigured", "signedOut", "signedIn"]),
  profile: Schema.optionalKey(PortableProfile),
  revision: Schema.optionalKey(Schema.String),
});
export type MicrosoftProfileResult = typeof MicrosoftProfileResult.Type;

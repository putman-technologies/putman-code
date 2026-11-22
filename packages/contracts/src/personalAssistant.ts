import * as Schema from "effect/Schema";

export const AssistantHost = Schema.String.check(
  Schema.isMaxLength(255),
  Schema.isPattern(/^(?:[a-zA-Z0-9_][a-zA-Z0-9._-]*@)?[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
);

export const AssistantAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("connect") }),
  Schema.Struct({ kind: Schema.Literal("state"), before: Schema.optionalKey(Schema.Int) }),
  Schema.Struct({
    kind: Schema.Literal("send"),
    id: Schema.String.check(Schema.isUUID()),
    prompt: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
    notify: Schema.Boolean,
  }),
  Schema.Struct({ kind: Schema.Literal("phone"), userKey: Schema.String, token: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("forgetPhone") }),
]);
export type AssistantAction = typeof AssistantAction.Type;
export const AssistantRequest = Schema.Struct({ host: AssistantHost, action: AssistantAction });
export const AssistantState = Schema.Struct({
  running: Schema.Boolean,
  alwaysOn: Schema.Boolean,
  phone: Schema.Boolean,
  older: Schema.Boolean,
  tasks: Schema.Array(
    Schema.Struct({
      seq: Schema.Int,
      id: Schema.String,
      prompt: Schema.String,
      answer: Schema.String,
      status: Schema.Literals(["queued", "running", "failed", "needs_input", "done"]),
      delivery: Schema.Literals(["off", "pending", "sending", "sent", "failed", "unknown"]),
    }),
  ),
});
export type AssistantState = typeof AssistantState.Type;

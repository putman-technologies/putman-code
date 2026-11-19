import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

interface TelemetryOwner {
  readonly source: "connect" | "openai" | "claude" | "device";
  readonly ownerId: string;
}

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    readonly flush: Effect.Effect<void>;

    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

// The fork has no product-analytics exporter. Callers can report activity locally
// through this interface without collecting identity, buffering events, or starting HTTP.
export const layer = Layer.succeed(
  AnalyticsService,
  AnalyticsService.of({
    record: Effect.fn("AnalyticsService.record")(() => Effect.void),
    recordOwners: Effect.fn("AnalyticsService.recordOwners")(() => Effect.void),
    flush: Effect.void,
  }),
);

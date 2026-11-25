import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    readonly flush: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

// The fork has no product-analytics exporter. Callers can report activity locally
// through this interface without collecting identity, buffering events, or starting HTTP.
export const layer = Layer.succeed(
  AnalyticsService,
  AnalyticsService.of({
    record: Effect.fn("AnalyticsService.record")(() => Effect.void),
    flush: Effect.void,
  }),
);

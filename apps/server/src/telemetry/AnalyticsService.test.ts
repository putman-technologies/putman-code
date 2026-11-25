import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { AnalyticsService, layer } from "./AnalyticsService.ts";

it.effect("sends zero usage requests even with the legacy exporter explicitly enabled", () =>
  Effect.gen(function* () {
    let requests = 0;
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        requests++;
        return HttpClientResponse.fromWeb(request, new Response());
      }),
    );
    yield* Effect.gen(function* () {
      const analytics = yield* AnalyticsService;
      yield* analytics.record("session.started");
      yield* analytics.flush;
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: {
            T3CODE_TELEMETRY_ENABLED: "true",
            T3CODE_POSTHOG_HOST: "https://analytics.invalid",
            T3CODE_POSTHOG_KEY: "example",
          },
        }),
      ),
    );
    assert.equal(requests, 0);
  }),
);

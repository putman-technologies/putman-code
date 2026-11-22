export type DesktopErrorEvent =
  | { type: "SlowRpc"; method: string; thresholdMs: number }
  | { type: "RendererError"; location?: string }
  | { type: "UnhandledRejection" | "ReactRenderError" | "IntegrationCheck" };

// Use the Sentry event envelope directly so only the fields below leave the device.
export async function sendDesktopError(dsn: string, version: string, event: DesktopErrorEvent) {
  const source = new URL(dsn);
  const project = source.pathname.slice(1);
  if (
    source.protocol !== "https:" ||
    !source.hostname.endsWith(".betterstackdata.com") ||
    !source.username ||
    source.password ||
    source.port ||
    !/^\d+$/.test(project)
  )
    throw new Error("Invalid Better Stack ingestion address");

  const url = new URL(`/api/${project}/envelope/`, source.origin);
  url.searchParams.set("sentry_key", source.username);
  url.searchParams.set("sentry_version", "7");
  // @effect-diagnostics-next-line cryptoRandomUUID:off -- The wire format needs a random event ID in both the browser and release checks.
  const eventId = crypto.randomUUID().replaceAll("-", "");
  const messages = {
    SlowRpc: "Request acknowledgement overdue",
    RendererError: "Uncaught desktop renderer error",
    UnhandledRejection: "Unhandled desktop promise rejection",
    ReactRenderError: "Desktop component failed to render",
    IntegrationCheck: "PutmanCode error tracking verification",
  };
  const fingerprint = ["putmancode-desktop", event.type];
  const tags: Record<string, string> = { surface: "desktop" };
  if (event.type === "SlowRpc") {
    tags.operation = event.method;
    tags.threshold_ms = String(event.thresholdMs);
    fingerprint.push(event.method);
  } else if (event.type === "RendererError" && event.location) {
    tags.asset_location = event.location;
    fingerprint.push(event.location);
  }
  const sentAt = new Date();
  const body =
    [
      { event_id: eventId, sent_at: sentAt.toISOString(), dsn },
      { type: "event" },
      {
        event_id: eventId,
        timestamp: sentAt.getTime() / 1000,
        platform: "javascript",
        release: `putmancode@${version}`,
        environment: event.type === "IntegrationCheck" ? "verification" : "desktop",
        level: event.type === "SlowRpc" ? "warning" : "error",
        exception: { values: [{ type: event.type, value: messages[event.type] }] },
        tags,
        fingerprint,
      },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n") + "\n";
  const response = await fetch(url, {
    method: "POST",
    body,
    credentials: "omit",
    referrerPolicy: "no-referrer",
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`Better Stack returned HTTP ${response.status}`);
}

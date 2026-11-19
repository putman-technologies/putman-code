# Product analytics

The PutmanCode server keeps the internal analytics interface for compatibility with agent and orchestration code. Its production implementation discards product events and owner observations. It has no network client, identity lookup, event queue, retry task, or shutdown upload.

See [telemetry settings](../user/telemetry.md) for diagnostics and operator-configured exports.

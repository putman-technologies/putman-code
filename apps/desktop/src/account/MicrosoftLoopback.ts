// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - A native login owns a bounded loopback listener.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import type * as NodeNet from "node:net";

export async function microsoftLoopback(
  endpoint: string,
  client: string,
  scope: string,
  open: (url: string) => Promise<boolean>,
  signal?: AbortSignal,
) {
  const state = NodeCrypto.randomBytes(32).toString("base64url");
  const verifier = NodeCrypto.randomBytes(48).toString("base64url");
  const callback = Promise.withResolvers<string>();
  void callback.promise.catch(() => undefined);
  const abort = () => callback.reject(new Error("Microsoft sign-in was cancelled."));
  let redirectUri = "";
  const server = NodeHttp.createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      response.writeHead(400).end();
      return;
    }
    const received = Buffer.from(url.searchParams.get("state") ?? "");
    if (
      request.method !== "GET" ||
      url.pathname !== "/" ||
      request.headers.host !== new URL(redirectUri).host ||
      received.length !== state.length ||
      !NodeCrypto.timingSafeEqual(received, Buffer.from(state))
    ) {
      response.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code");
    const success = !!code && !url.searchParams.has("error");
    response.once("finish", () => {
      if (success) callback.resolve(code);
      else callback.reject(new Error("Microsoft sign-in was declined."));
    });
    response
      .writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      })
      .end(
        success
          ? "Return to PutmanCode to finish signing in."
          : "Sign-in was cancelled. Return to PutmanCode.",
      );
  });
  const timer = setTimeout(
    () => callback.reject(new Error("Microsoft sign-in timed out.")),
    180000,
  );
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    redirectUri = "http://localhost:" + (server.address() as NodeNet.AddressInfo).port;
    if (signal?.aborted) throw new Error("Microsoft sign-in was cancelled.");
    const params = new URLSearchParams({
      client_id: client,
      response_type: "code",
      scope,
      redirect_uri: redirectUri,
      state,
      code_challenge_method: "S256",
      code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
      prompt: "select_account",
    });
    if (!(await open(endpoint + "?" + params.toString())))
      throw new Error("Could not open the Microsoft sign-in page.");
    return { code: await callback.promise, verifier, redirectUri };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    server.close();
    server.closeAllConnections();
  }
}

// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Exercise the native callback with a real HTTP browser request and verify the PKCE digest.
import { expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import { microsoftLoopback } from "./MicrosoftLoopback.ts";

it("accepts the matching native redirect and exchanges its original PKCE verifier", async () => {
  let challenge = "";
  const result = await microsoftLoopback(
    "https://login.microsoftonline.com/example/oauth2/v2.0/authorize",
    "app",
    "test",
    async (href) => {
      const url = new URL(href);
      challenge = url.searchParams.get("code_challenge")!;
      const target = new URL(url.searchParams.get("redirect_uri")!);
      target.searchParams.set("code", "fixture");
      target.searchParams.set("state", "wrong");
      expect((await fetch(target)).status).toBe(404);
      target.searchParams.set("state", url.searchParams.get("state")!);
      expect((await fetch(target)).status).toBe(200);
      return true;
    },
  );
  expect(result.code).toBe("fixture");
  expect(NodeCrypto.createHash("sha256").update(result.verifier).digest("base64url")).toBe(
    challenge,
  );
});

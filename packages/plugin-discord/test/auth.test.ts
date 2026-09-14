import assert from "node:assert/strict";
import test from "node:test";
import type { Rpc } from "../../common/src/runtime/rpc.js";
import { DiscordAuth } from "../src/auth/sessions.js";
import { normalizeDiscordPolicy } from "../src/input/policy.js";
test("OAuth links use public or local origin, single-use state and the original Engine identity context", async () => {
  const calls: unknown[] = [];
  const rpc = {
    request: async (...args: unknown[]) => {
      calls.push(args);
      return { token: "activity-token" };
    },
  } as unknown as Rpc;
  const auth = new DiscordAuth(
    () => ({ appId: "123", clientSecret: "synthetic" }),
    () => rpc,
    async (input) => {
      calls.push(input);
      return { user: { id: "456" }, accessToken: "synthetic-access" };
    },
  );
  for (const origin of [
    "http://127.0.0.1:4310",
    "https://engine.example.com",
  ]) {
    const url = new URL(auth.start("engine-context", origin));
    assert.equal(
      url.searchParams.get("redirect_uri"),
      origin + "/plugins/discord/callback",
    );
    assert.equal(url.searchParams.get("client_id"), "123");
    await auth.callback(url.searchParams.get("state")!, "synthetic-code");
    assert.deepEqual(calls.at(-1), [
      "identity.link",
      { subject: "456" },
      "engine-context",
    ]);
    await assert.rejects(
      auth.callback(url.searchParams.get("state")!, "synthetic-code"),
      /OAUTH_STATE_EXPIRED/,
    );
  }
  assert.deepEqual(await auth.activity("synthetic-code"), {
    token: "activity-token",
    accessToken: "synthetic-access",
  });
  assert.deepEqual(calls.at(-1), ["identity.session", { subject: "456" }]);
});
test("Discord policy normalization remains owned by the adapter", () => {
  assert.deepEqual(normalizeDiscordPolicy({}), {
    userPolicy: "all",
    allowedUserIds: "",
  });
  assert.deepEqual(
    normalizeDiscordPolicy({
      userPolicy: "allowlist",
      allowedUserIds: "100, 200\n100",
    }),
    { userPolicy: "allowlist", allowedUserIds: "100\n200" },
  );
  assert.throws(
    () => normalizeDiscordPolicy({ allowedUserIds: "not-an-id" }),
    /INVALID_DISCORD_USER_IDS/,
  );
});

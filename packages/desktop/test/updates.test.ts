import assert from "node:assert/strict";
import test from "node:test";
import { checkUpdate } from "../src/updates.js";
test("updates use only the fixed public release feed and compare numeric versions", async () => {
  const request: typeof fetch = async (url, options) => {
    assert.equal(
      String(url),
      "https://api.github.com/repos/pikachu0310/personal-context-hub-discord-voice/releases/latest",
    );
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    return Response.json({
      tag_name: "v0.10.0",
      draft: false,
      prerelease: false,
    });
  };
  assert.equal((await checkUpdate("0.9.9", request)).status, "available");
  assert.equal((await checkUpdate("0.10.0", request)).status, "current");
  assert.equal((await checkUpdate("1.0.0", request)).status, "current");
  assert.equal(
    (
      await checkUpdate(
        "0.1.0",
        async () => new Response(null, { status: 404 }),
      )
    ).status,
    "unpublished",
  );
  await assert.rejects(
    checkUpdate("0.1.0", async () =>
      Response.json({ tag_name: "v0.2.0", prerelease: true }),
    ),
    /INVALID_RELEASE/,
  );
  await assert.rejects(
    checkUpdate("0.1.0", async () => new Response(null, { status: 500 })),
    /UPDATE_CHECK_FAILED/,
  );
});

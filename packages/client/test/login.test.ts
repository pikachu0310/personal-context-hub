import assert from "node:assert/strict";
import test from "node:test";
import { officialLoginUrl } from "../src/auth/login.js";
test("browser login exposes only complete official authorization URLs, never raw CLI output", () => {
  assert.equal(
    officialLoginUrl(
      "private-log https://auth.openai.com/oauth/authorize?state=example\n",
    ),
    "https://auth.openai.com/oauth/authorize?state=example",
  );
  assert.equal(
    officialLoginUrl(
      "https://auth.openai.com/oauth/authorize?state=incomplete",
    ),
    undefined,
  );
  assert.equal(
    officialLoginUrl("https://auth.openai.com.evil.example/oauth/authorize\n"),
    undefined,
  );
  assert.equal(
    officialLoginUrl("https://secret@auth.openai.com/oauth/authorize\n"),
    undefined,
  );
  assert.equal(officialLoginUrl("private-token-value"), undefined);
});

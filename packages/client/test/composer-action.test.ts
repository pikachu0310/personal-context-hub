import assert from "node:assert/strict";
import test from "node:test";
import { composerAction } from "../src/ui/composer-action.js";
test("typing replaces stop with send, and finishing keeps send even with an empty composer", () => {
  assert.equal(composerAction(true, ""), "stop");
  assert.equal(composerAction(true, "追記"), "send");
  assert.equal(composerAction(true, " \n"), "stop");
  assert.equal(composerAction(false, ""), "send");
  assert.equal(composerAction(false, "続けてください"), "send");
});

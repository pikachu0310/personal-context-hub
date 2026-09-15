import assert from "node:assert/strict";
import test from "node:test";
import { endpoint } from "../src/contracts/protocol.js";

test("Engine endpoints accept HTTP and HTTPS on arbitrary hosts", () => {
  for (const origin of [
    "http://192.168.1.50:4310",
    "http://engine.lan:4310",
    "http://[fd00::1]:4310",
    "http://localhost:4310",
    "https://engine.example.com",
  ])
    assert.equal(endpoint(origin).origin, origin);
  for (const origin of [
    "ftp://engine.lan",
    "file:///",
    "http://user:password@engine.lan",
    "http://engine.lan/path",
    "http://engine.lan/?token=secret",
    "http://engine.lan/#fragment",
  ])
    assert.throws(() => endpoint(origin));
});

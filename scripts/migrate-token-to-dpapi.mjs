import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import {
  getTokenBackend,
  getTokenPath,
  getTokenStoreDescription,
  readTokenStore,
  writeTokenStore,
} from "../src/config.mjs";

if (getTokenBackend() !== "dpapi") {
  throw new Error(
    "Set PERSONAL_CONTEXT_TOKEN_BACKEND=dpapi or run this script from Windows/WSL.",
  );
}

const legacyPath = getTokenPath();
const legacy = await readTokenStore(legacyPath);
await writeTokenStore(legacy);
const migrated = await readTokenStore();
assert.equal(migrated.clientId, legacy.clientId);
assert.equal(migrated.accessToken, legacy.accessToken);
await unlink(legacyPath);

console.log(`Migrated traQ OAuth token to ${getTokenStoreDescription()}`);
console.log(`Removed plaintext token store: ${legacyPath}`);

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import type { Client } from "../bootstrap/client.js";

export async function restoreIdentity(client: Client) {
  const saved = await client.credentials.get("device.privateKey");
  if (saved) {
    const key = createPrivateKey(saved);
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("DEVICE_KEY_INVALID");
    const publicKey = createPublicKey(key)
      .export({ format: "pem", type: "spki" })
      .toString();
    if (
      client.settings.publicKey &&
      createPublicKey(client.settings.publicKey)
        .export({ format: "pem", type: "spki" })
        .toString() !== publicKey
    )
      throw new Error("DEVICE_KEY_MISMATCH");
    client.identityStatus = client.settings.publicKey
      ? "restored"
      : "public key recovered";
    if (client.settings.publicKey !== publicKey) {
      client.settings.publicKey = publicKey;
      await client.save();
    }
    return;
  }
  if (
    client.settings.publicKey ||
    client.settings.deviceId ||
    client.settings.pendingPair
  )
    throw new Error("DEVICE_KEY_UNAVAILABLE: restore the saved Client data");
  const keys = generateKeyPairSync("ed25519");
  await client.credentials.set(
    "device.privateKey",
    keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  );
  client.settings.publicKey = keys.publicKey
    .export({ format: "pem", type: "spki" })
    .toString();
  await client.save();
  client.identityStatus = "created";
}

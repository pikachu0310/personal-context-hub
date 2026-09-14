import { createPublicKey, randomUUID } from "node:crypto";
import { hash } from "@ido/common/runtime/platform";
import type { Repository } from "../ports/repository.js";
import type { Device } from "../domain/models.js";

export function normalizedDeviceKey(publicKey: string) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("INVALID_KEY");
  return key.export({ format: "pem", type: "spki" }).toString();
}

// Presentation only. Device IDs remain the authorization and execution keys.
export function deviceIdentity(
  store: Repository,
  device: Device,
): string | undefined {
  let key: string;
  try {
    key = normalizedDeviceKey(device.publicKey);
  } catch {
    return undefined;
  }
  let namespace = store.get<{ id: string }>("config", "identity-namespace");
  if (!namespace) {
    namespace = { id: randomUUID() };
    store.put("config", "identity-namespace", namespace);
  }
  return `client:${hash(JSON.stringify([namespace.id, device.userId, key]))}`;
}

export function matchingDevices(
  store: Repository,
  userId: string,
  publicKey: string,
) {
  const key = normalizedDeviceKey(publicKey);
  return store.list<Device>("device").filter((device) => {
    if (device.revoked || device.userId !== userId) return false;
    try {
      return normalizedDeviceKey(device.publicKey) === key;
    } catch {
      return false;
    }
  });
}

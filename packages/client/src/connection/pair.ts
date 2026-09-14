import { hostname } from "node:os";
import { endpoint } from "@ido/common/contracts/protocol";
import { hash } from "@ido/common/runtime/platform";

import type { Client } from "../bootstrap/client.js";
export async function pair(this: Client, engineUrl: string) {
  if (this.stopping) throw new Error("CLIENT_STOPPING");
  if (this.pairStart) throw new Error("PAIRING_ALREADY_PENDING");
  this.pairStart = startPair.call(this, engineUrl);
  try {
    await this.pairStart;
  } finally {
    this.pairStart = undefined;
  }
}
async function startPair(this: Client, engineUrl: string) {
  if (this.pairing || this.pairRequest)
    throw new Error("PAIRING_ALREADY_PENDING");
  if (this.settings.deviceId)
    throw new Error(
      "ALREADY_PAIRED: revoke and disconnect this device before changing engines",
    );
  const origin = endpoint(engineUrl).origin;
  if (this.settings.pendingPair) {
    await this.credentials.set(`pair.${this.settings.pendingPair.id}`, "");
    delete this.settings.pendingPair;
  }
  this.settings.engineUrl = origin;
  await this.save();
  const response = await fetch(origin + "/api/admin/pair/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: this.settings.profile?.name || hostname(),
      publicKey: this.settings.publicKey,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("PAIR_REQUEST_FAILED");
  const result = (await response.json()) as {
    id: string;
    proof: string;
    url: string;
    expires: number;
  };
  await this.credentials.set(`pair.${result.id}`, result.proof);
  this.settings.pendingPair = {
    id: result.id,
    engineUrl: origin,
    expires: result.expires,
  };
  await this.save();
  this.pairing = {
    ...result,
    url: `${origin}/admin/pair/${result.id}`,
    fingerprint: hash(this.settings.publicKey!),
  };
  this.pollPair();
}

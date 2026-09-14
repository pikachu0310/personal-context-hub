import { hostname } from "node:os";
import { endpoint } from "@ido/common/contracts/protocol";
import { hash } from "@ido/common/runtime/platform";

import type { Client } from "../bootstrap/client.js";
export async function pair(this: Client, engineUrl: string) {
  if (this.settings.deviceId)
    throw new Error(
      "ALREADY_PAIRED: revoke and disconnect this device before changing engines",
    );
  const origin = endpoint(engineUrl).origin;
  this.settings.engineUrl = origin;
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
  };
  this.pairing = {
    ...result,
    url: `${origin}/admin/pair/${result.id}`,
    fingerprint: hash(this.settings.publicKey!),
  };
  this.pollPair();
}

import { type Project } from "@ido/common/contracts/protocol";

import type { Client } from "../bootstrap/client.js";
export function pollPair(this: Client) {
  clearTimeout(this.pairTimer);
  if (this.stopping) return;
  this.pairTimer = setTimeout(() => {
    this.pairRequest = (async () => {
      const pair = this.pairing;
      if (!pair || !this.settings.engineUrl) return;
      const response = await fetch(
        this.settings.engineUrl + "/api/admin/pair/poll",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: pair.id, proof: pair.proof }),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (this.stopping || this.pairing !== pair) return;
      if ([403, 410].includes(response.status)) {
        this.pairing = undefined;
        this.status = "pairing expired";
        delete this.settings.pendingPair;
        await this.save();
        await this.credentials.set(`pair.${pair.id}`, "");
        return;
      }
      if (!response.ok) throw new Error("PAIR_POLL_FAILED");
      const result = (await response.json()) as {
        pending?: boolean;
        deviceId: string;
        projects: Project[];
      };
      if (result.pending) {
        this.pollPair();
        return;
      }
      this.settings.deviceId = result.deviceId;
      this.settings.projects = result.projects;
      delete this.settings.pendingPair;
      await this.save();
      this.pairing = undefined;
      await this.credentials.set(`pair.${pair.id}`, "");
      await this.connect();
    })()
      .catch(() => {
        this.status = "pairing network error";
        this.pollPair();
      })
      .finally(() => {
        this.pairRequest = undefined;
      });
  }, 2000);
}

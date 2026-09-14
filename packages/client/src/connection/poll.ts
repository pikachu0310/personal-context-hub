import { type Project } from "@ido/common/contracts/protocol";

import type { Client } from "../bootstrap/client.js";
export function pollPair(this: Client) {
  clearTimeout(this.pairTimer);
  this.pairTimer = setTimeout(() => {
    void (async () => {
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
      if (!response.ok) {
        this.pairing = undefined;
        this.status = "pairing expired";
        return;
      }
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
      await this.save();
      this.pairing = undefined;
      await this.connect();
    })().catch(() => {
      this.status = "pairing network error";
      this.pollPair();
    });
  }, 2000);
}

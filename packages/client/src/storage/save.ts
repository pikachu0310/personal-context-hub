import { join } from "node:path";
import { atomic } from "@ido/common/runtime/platform";

import type { Executor } from "../execution/executor.js";
export function save(this: Executor) {
  const snapshot = JSON.parse(
    JSON.stringify({
      runs: this.runs,
      commands: this.commands,
      deletedTasks: this.deletedTasks,
      pendingPurges: this.pendingPurges,
    }),
  );
  this.saving = this.saving
    .catch(() => {})
    .then(() => atomic(join(this.directory, "runs.json"), snapshot));
  return this.saving;
}

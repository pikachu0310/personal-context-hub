import { join } from "node:path";
import { atomic } from "../../../common/src/runtime/platform.js";

import type { Executor } from "../execution/executor.js";
export function save(this: Executor) {
  const snapshot = JSON.parse(
    JSON.stringify({ runs: this.runs, commands: this.commands }),
  );
  this.saving = this.saving
    .catch(() => {})
    .then(() => atomic(join(this.directory, "runs.json"), snapshot));
  return this.saving;
}

import { AppServerCodex } from "../codex/app-server.mjs";
import { codexBinary } from "../codex/binary.js";
import { workerEnvironment } from "@ido/common/runtime/platform";
import { selectedModel } from "./model-selection.js";

export async function codexModels(
  home: string,
  create = () =>
    new AppServerCodex({
      codexPathOverride: codexBinary(),
      env: workerEnvironment(home),
    }),
) {
  const runtime = create();
  try {
    const models = new Map<string, { id: string; name: string }>();
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const result = await runtime.request("model/list", {
        limit: 100,
        cursor,
      });
      for (const value of result.data ?? []) {
        if (value.hidden) continue;
        const id = selectedModel(value.model);
        if (id)
          models.set(id, {
            id,
            name: String(value.displayName ?? id).slice(0, 120),
          });
      }
      cursor = result.nextCursor;
      if (!cursor) return [...models.values()];
    }
    throw new Error("MODEL_LIST_TOO_LARGE");
  } finally {
    await runtime.close();
  }
}

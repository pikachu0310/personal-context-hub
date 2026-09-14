# @ido/common

Shared communication contracts and low-level runtime utilities. Consumers use
explicit package subpaths, which resolve only to compiled JavaScript and type
declarations in `dist`:

```ts
import type { Task } from "@ido/common/contracts/protocol";
import { Rpc } from "@ido/common/runtime/rpc";
import { AppServerCodex } from "@ido/common/runtime/codex/app-server";
```

Browser code can use contracts and `@ido/common/runtime/browser-api`. Node-only
utilities stay in separate modules; there is no aggregate root export that pulls
them into browser builds. Source and distribution internals are not public
import paths.

Run `npm run build:common` from the repository root to rebuild. TypeScript emits
`.js`/`.d.ts` for TypeScript sources and `.mjs`/`.d.mts` for the existing JavaScript
modules, preserving internal relative imports. No TypeScript loader is needed to
execute the output.

`build:common-ui` builds common first. The root check, build and test commands
therefore build in dependency order: common, common-ui, then consumers. Rebuild
after shared-code changes before running an application's development server.

Engine, Client and plugins declare common as a development dependency because
their distribution builds bundle its runtime code. Their installed tarballs do
not need the private common workspace. Common UI declares a dependency on common
because its public type declarations refer to the common contract exports.

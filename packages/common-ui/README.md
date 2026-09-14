# @ido/common-ui

Shared React/Mantine components and workspace views for Engine administration,
Client, Dashboard and Discord Activity. Views receive state and actions from their
owner; networking stays in the owning application.

Consumers declare `@ido/common-ui` as a development dependency and import its
compiled public entry:

```tsx
import { Card, Workspace, type WorkspaceState } from "@ido/common-ui";
import "@ido/common-ui/style.css";
```

Run `npm run build:common-ui` from the repository root after changing shared UI,
including before starting an application's Vite development server.
`npm run check:ido`, `npm run build:ido` and `npm run test:ido` build this package first, so clean
checkouts do not need a separate bootstrap step.

The build first compiles `@ido/common`, then produces `dist/index.js`,
`dist/style.css` and declarations under `dist/types`. React and Mantine remain
peer dependencies, supplied by each application. Public declarations reference
the compiled contract exports of the declared `@ido/common` dependency.
Exports expose only compiled files; do not import another package's source or
distribution files using relative paths.

Application builds bundle this UI into their own `dist/ui` assets. Installed
Engine, Client and plugin tarballs therefore do not need this private workspace
package at runtime.

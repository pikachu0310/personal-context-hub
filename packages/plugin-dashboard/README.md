# IDO Dashboard Plugin

Bundled with IDO Engine and started by default in a separate process. Requires Node.js 24.x. Business pages and the browser-facing API are available through Engine at `/dashboard/`.

The React/Mantine UI has meeting, minutes, project, task and artifact pages. It calls Engine through protocol-2 IPC; Engine owns business state and authorization. No provider credentials are stored in the browser. Shared presentation components receive data and actions from this plugin.

Use Engine administration at `/admin` to stop or restart Dashboard. Administration, Discord and Client execution remain available when it is stopped. The browser fetches current Engine state after restart.

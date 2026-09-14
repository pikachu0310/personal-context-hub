import {
  PLUGIN_PROTOCOL,
  type PluginManifest,
} from "../../common/src/contracts/plugins.js";
import { RELEASE } from "../../common/src/contracts/protocol.js";
export const dashboardManifest: PluginManifest = {
  id: "dashboard",
  version: RELEASE,
  protocol: PLUGIN_PROTOCOL,
  title: "Dashboard",
  fields: [],
  capabilities: ["web", "text"],
  web: { basePath: "/dashboard", publicPaths: ["/", "/assets/"] },
};

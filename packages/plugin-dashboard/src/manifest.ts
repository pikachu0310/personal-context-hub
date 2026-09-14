import {
  PLUGIN_PROTOCOL,
  type PluginManifest,
} from "@ido/common/contracts/plugins";
import { RELEASE } from "@ido/common/contracts/protocol";
export const dashboardManifest: PluginManifest = {
  id: "dashboard",
  version: RELEASE,
  protocol: PLUGIN_PROTOCOL,
  title: "Dashboard",
  fields: [],
  capabilities: ["web", "text"],
  web: { basePath: "/dashboard", publicPaths: ["/", "/assets/"] },
};

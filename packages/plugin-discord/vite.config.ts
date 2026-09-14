import { resolve } from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  esbuild: { jsx: "automatic" },
  root: resolve("packages/plugin-discord/src/activity/web"),
  base: "/plugins/discord/",
  build: {
    outDir: resolve("packages/plugin-discord/dist/ui"),
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
});

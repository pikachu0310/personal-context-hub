import { resolve } from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  esbuild: { jsx: "automatic" },
  root: resolve("packages/plugin-dashboard/src/web"),
  base: "/dashboard/",
  build: {
    outDir: resolve("packages/plugin-dashboard/dist/ui"),
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
});

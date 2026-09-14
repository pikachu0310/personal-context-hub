import { resolve } from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  esbuild: { jsx: "automatic" },
  root: resolve("packages/engine/src/ui"),
  base: "/admin/",
  build: {
    outDir: resolve("packages/engine/dist/ui"),
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
});

import { resolve } from "node:path";
import { defineConfig } from "vite";
export default defineConfig({
  esbuild: { jsx: "automatic" },
  root: resolve("packages/client/src/ui"),
  base: "/",
  build: {
    outDir: resolve("packages/client/dist/ui"),
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code !== "MODULE_LEVEL_DIRECTIVE") warn(warning);
      },
    },
  },
});

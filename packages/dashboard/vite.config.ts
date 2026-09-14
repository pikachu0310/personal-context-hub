import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({
  root: resolve("packages/dashboard"),
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      onwarn(warning, warn) {
        if (
          warning.code === "MODULE_LEVEL_DIRECTIVE" &&
          warning.message.includes("use client")
        )
          return;
        warn(warning);
      },
    },
  },
  server: { host: "127.0.0.1" },
});

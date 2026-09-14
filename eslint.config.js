import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "v0/**",
      "ui/node_modules/**",
      "ui/dist/**",
      "packages/*/dist/**",
      "packages/*/node_modules/**",
      ".ido-build/**",
      ".desktop-build/**",
      "dist/**",
      ".private/**",
      ".codex_tmp_*/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
        fetch: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
];

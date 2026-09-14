import { createRequire } from "node:module";
import { dirname, join } from "node:path";
export function codexBinary() {
  const require = createRequire(import.meta.url);
  const cpu = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  const target = {
    win32: "pc-windows-msvc",
    darwin: "apple-darwin",
    linux: "unknown-linux-musl",
  }[process.platform];
  return join(
    dirname(
      require.resolve(
        `@openai/codex-${process.platform}-${process.arch}/package.json`,
      ),
    ),
    "vendor",
    `${cpu}-${target}`,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
}

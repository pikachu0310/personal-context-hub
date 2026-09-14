import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export function codexBinary() {
  const require = createRequire(import.meta.url);
  const cpu = { x64: "x86_64", arm64: "aarch64" }[
    process.arch as "x64" | "arm64"
  ];
  const target = {
    darwin: "apple-darwin",
    linux: "unknown-linux-musl",
    win32: "pc-windows-msvc",
  }[process.platform as "darwin" | "linux" | "win32"];
  if (!cpu || !target) throw new Error("UNSUPPORTED_PLATFORM");
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

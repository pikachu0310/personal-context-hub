import { readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

// Discover nested modules so moving a file cannot silently remove syntax checks.
for (const directory of ["src", "scripts"]) {
  const files = await readdir(directory, { recursive: true });
  for (const file of files.filter((path) => path.endsWith(".mjs")).sort()) {
    execFileSync(process.execPath, ["--check", join(directory, file)], {
      stdio: "inherit",
    });
  }
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
await mkdir(".ido-build/tarballs", { recursive: true });
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const packages = [];
for (const name of ["engine", "client", "plugin-discord", "plugin-dashboard"]) {
  const result = JSON.parse(
    execFileSync(
      npm,
      [
        "pack",
        `./packages/${name}`,
        "--pack-destination",
        ".ido-build/tarballs",
        "--json",
      ],
      { encoding: "utf8", shell: process.platform === "win32" },
    ),
  )[0];
  const manifest = JSON.parse(
    await readFile(`packages/${name}/package.json`, "utf8"),
  );
  const forbidden = result.files.filter((f) =>
    /(?:\.env|secrets\.json|auth\.json|\.sqlite|client\.json|runtime\.json|AGENTS\.override)/.test(
      f.path,
    ),
  );
  if (forbidden.length) throw new Error(`Unexpected private file in ${name}`);
  for (const file of result.files) {
    const content = await readFile(`packages/${name}/${file.path}`, "utf8");
    if (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/]{20}|\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}|\b(?:mfa\.[A-Za-z0-9_-]{40,})|\/Users\/[A-Za-z0-9_-]+\//.test(
        content,
      )
    )
      throw new Error(
        `Potential credential or machine-specific path in ${name}/${file.path}`,
      );
  }
  if (!result.files.some((f) => f.path === "dist/index.js"))
    throw new Error(`Build missing for ${name}`);
  if (!result.files.some((f) => f.path === "dist/ui/index.html"))
    throw new Error(`Bundled UI missing for ${name}`);
  if (
    name === "engine" &&
    (manifest.dependencies["@openai/codex"] ||
      Object.keys(manifest.dependencies).some((d) =>
        /discord|electron/.test(d),
      ))
  )
    throw new Error("Engine dependency boundary failed");
  packages.push({
    name: manifest.name,
    path: resolve(".ido-build/tarballs", result.filename),
    bytes: result.size,
    files: result.files.length,
  });
}
await writeFile(".ido-build/packages.json", JSON.stringify(packages, null, 2));
console.log(
  JSON.stringify(
    packages.map(({ name, bytes, files }) => ({ name, bytes, files })),
    null,
    2,
  ),
);

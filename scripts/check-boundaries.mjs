import { readdir, readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import ts from "typescript";
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (/\.(?:tsx?|mjs)$/.test(entry.name)) result.push(path);
  }
  return result;
}
export async function checkBoundaries(root = resolve("packages")) {
  const errors = [];
  for (const path of await files(root)) {
    const source = relative(root, path).replaceAll("\\", "/");
    if (!source.includes("/src/")) continue;
    const contents = await readFile(path, "utf8");
    const file = ts.createSourceFile(
      path,
      contents,
      ts.ScriptTarget.Latest,
      true,
    );
    const imports = [];
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        ts.isStringLiteral(node.arguments[0])
      )
        imports.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    }
    visit(file);
    for (const specifier of imports) {
      const target = specifier.startsWith(".")
        ? relative(root, resolve(path, "..", specifier)).replaceAll("\\", "/")
        : specifier.replace(/^@ido\/([^/]+)(?:\/|$)/, "$1/src/");
      const core =
        /^engine\/src\/(domain|ports|input|messages|processing|clients|output|management)\//.test(
          source,
        );
      if (
        target.startsWith("../") ||
        (source.startsWith("engine/") && /^plugin-/.test(target)) ||
        (source.startsWith("plugin-") && /^(engine|client)\//.test(target)) ||
        (source.startsWith("common/") &&
          (specifier.startsWith(".") || specifier.startsWith("@ido/")) &&
          !target.startsWith("common/")) ||
        (source.startsWith("common-ui/") &&
          /^(engine|client|plugin-)\//.test(target)) ||
        (core &&
          (/^engine\/src\/(adapters|bootstrap)\//.test(target) ||
            /^(openai|ws|discord.js|node:(?:sqlite|http|https|child_process))$/.test(
              target,
            )))
      )
        errors.push(`${source} -> ${target}`);
      for (const name of ["common", "common-ui"])
        if (
          !source.startsWith(`${name}/`) &&
          specifier.startsWith(".") &&
          target.startsWith(`${name}/`)
        )
          errors.push(`${source}: import ${name} through @ido/${name} exports`);
    }
    if (source.startsWith("common-ui/") && /\bfetch\s*\(/.test(contents))
      errors.push(`${source}: UI must receive data and actions`);
  }
  if (errors.length)
    throw new Error(`Architecture boundary violations:\n${errors.join("\n")}`);
}

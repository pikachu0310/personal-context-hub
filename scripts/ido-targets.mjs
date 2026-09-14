export const runtimePackages = [
  "engine",
  "client",
  "plugin-discord",
  "plugin-dashboard",
];
export const suites = [
  "common",
  "common-ui",
  ...runtimePackages,
  "desktop",
  "tooling",
];

export function isSelectedSource(path, root, selected) {
  const normalized = path.replaceAll("\\", "/");
  const prefix = root.replaceAll("\\", "/").replace(/\/$/, "") + "/packages/";
  return selected.some((name) => normalized.startsWith(`${prefix}${name}/`));
}

export function selectedSuites(value) {
  const selected = value === undefined ? suites : JSON.parse(value);
  if (
    !Array.isArray(selected) ||
    selected.some((name) => !suites.includes(name))
  )
    throw new Error("IDO_PACKAGES must be a JSON array of known suite names");
  return [...new Set(selected)];
}

export function testBuilds(selected, full = false) {
  if (full) return runtimePackages;
  const builds = new Set(
    selected.filter((name) => runtimePackages.includes(name)),
  );
  // Engine tests launch both real plugin processes. They import Client source.
  if (selected.includes("engine")) {
    builds.add("plugin-dashboard");
    builds.add("plugin-discord");
  }
  return [...builds];
}

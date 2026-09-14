const writes = new Set([
  "/invitation",
  "/approve",
  "/approve-command",
  "/login",
  "/refresh-login",
  "/connect",
  "/stop",
  "/stop-task",
  "/pause-task",
  "/resume-task",
  "/folder",
  "/setup-sandbox",
]);
export function allowedDesktopRequest(path, input) {
  if (path === "/status") return input === undefined;
  if (path === "/local-tasks")
    return Boolean(
      input &&
      Object.keys(input).length === 1 &&
      typeof input.enabled === "boolean",
    );
  if (
    !writes.has(path) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    return false;
  try {
    return JSON.stringify(input).length <= 16000;
  } catch {
    return false;
  }
}
export function allowedExternalUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      ["auth.openai.com", "git-scm.com"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

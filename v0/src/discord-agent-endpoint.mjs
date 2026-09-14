// One policy for invitations, browser UI, CLI Worker and the host Gateway.
export function validateAgentEndpoint(value) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\s\\?#]/.test(value)
  )
    throw new Error(
      "Worker URL must not contain whitespace, queries or fragments.",
    );
  const url = new URL(value);
  if (url.username || url.password)
    throw new Error("Worker URL must not contain credentials.");
  const loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if (url.protocol !== "wss:" && !(loopback && url.protocol === "ws:"))
    throw new Error("Worker connections must use wss:// away from loopback.");
  // Reject normalization tricks as well as encoded separators and dot segments.
  const rawPath = value.match(/^[a-z]+:\/\/[^/]+(\/.*)$/i)?.[1] ?? "/";
  if (
    rawPath !== url.pathname ||
    !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?)?$/.test(rawPath)
  )
    throw new Error("Worker URL must use a literal endpoint path.");
  return { url, loopback, path: url.pathname };
}

import { endpoint } from "@ido/common/contracts/protocol";
export function previewRequestAllowed(
  url: string,
  frameUrl: string,
  resourceType: string,
  clientOrigin: string,
  registered: (value: string) => boolean,
) {
  if (registered(frameUrl)) return registered(url);
  return (
    localSender(url, clientOrigin) ||
    (resourceType === "subFrame" && registered(url))
  );
}
export function parseJoinLink(value: string) {
  if (value.length > 4096) throw new Error("INVALID_JOIN_LINK");
  const url = new URL(value);
  if (
    url.protocol !== "ido-agent:" ||
    url.hostname !== "connect" ||
    !["", "/"].includes(url.pathname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    [...url.searchParams.keys()].some((key) => key !== "engine") ||
    url.searchParams.getAll("engine").length !== 1
  )
    throw new Error("INVALID_JOIN_LINK");
  return endpoint(url.searchParams.get("engine")).origin;
}
export function localSender(value: string, origin: string) {
  try {
    const url = new URL(value);
    return url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}
export function externalLink(
  value: string,
  pairing?: string,
  login?: string,
  claudeLogin?: string,
) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (value === "https://code.claude.com/docs/en/authentication") return true;
    if (value === claudeLogin)
      return (
        [
          "https://claude.ai",
          "https://platform.claude.com",
          "https://console.anthropic.com",
        ].includes(url.origin) && url.pathname === "/oauth/authorize"
      );
    if (value === pairing)
      return (
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      );
    return value === login && url.origin === "https://auth.openai.com";
  } catch {
    return false;
  }
}

export function parseProjectLink(value: string) {
  if (value.length > 4096) throw new Error("INVALID_JOIN_LINK");
  const url = new URL(value);
  if (
    url.protocol !== "ido-agent:" ||
    url.hostname !== "project" ||
    !["", "/"].includes(url.pathname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    [...url.searchParams.keys()].some(
      (k) => !["engine", "token"].includes(k),
    ) ||
    url.searchParams.getAll("engine").length !== 1 ||
    url.searchParams.getAll("token").length !== 1 ||
    !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("token") ?? "")
  )
    throw new Error("INVALID_JOIN_LINK");
  return {
    engineUrl: endpoint(url.searchParams.get("engine")).origin,
    token: url.searchParams.get("token")!,
  };
}

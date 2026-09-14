import { endpoint } from "../../common/src/contracts/protocol.js";
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
export function externalLink(value: string, pairing?: string, login?: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
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

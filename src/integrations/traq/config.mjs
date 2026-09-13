import { homedir } from "node:os";
import { join } from "node:path";
import {
  createCredentialStore,
  defaultCredentialBackend,
} from "../../storage/credential-store.mjs";

export const TRAQ_ORIGIN = process.env.TRAQ_ORIGIN ?? "https://q.trap.jp";
export const TRAQ_API_BASE = new URL("/api/v3/", TRAQ_ORIGIN);
export const TRAQ_REDIRECT_URI = "http://127.0.0.1:8943/oauth/callback";
export const TRAQ_CALLBACK_PORT = 8943;
export const TRAQ_OAUTH_SCOPES = [
  "openid",
  "profile",
  "read",
  "write",
  "manage_bot",
];

const store = createCredentialStore({
  getBackend: getTokenBackend,
  getPath: getTokenPath,
  dpapiScript: new URL(
    "../../../scripts/traq-token-dpapi.ps1",
    import.meta.url,
  ),
  operationName: "token",
});

export function getTokenBackend() {
  if (process.env.PERSONAL_CONTEXT_TOKEN_PATH) return "file";
  if (process.env.PERSONAL_CONTEXT_TOKEN_BACKEND) {
    return process.env.PERSONAL_CONTEXT_TOKEN_BACKEND;
  }
  return defaultCredentialBackend();
}

export function getTokenPath() {
  if (process.env.PERSONAL_CONTEXT_TOKEN_PATH) {
    return process.env.PERSONAL_CONTEXT_TOKEN_PATH;
  }

  const dataRoot =
    process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(dataRoot, "personal-context-hub", "traq-oauth.json");
}

export function getTokenStoreDescription() {
  return getTokenBackend() === "dpapi"
    ? "Windows DPAPI CurrentUser: %LOCALAPPDATA%\\personal-context-hub\\traq-oauth.dpapi"
    : getTokenPath();
}

export async function readTokenStore(path) {
  let token;
  try {
    token = await store.read(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "traQ is not authenticated. Run: npm run auth:traq -- --client-id <CLIENT_ID>",
      );
    }
    throw error;
  }

  if (!token.clientId || !token.accessToken || !token.expiresAt) {
    throw new Error(
      `Invalid traQ token store at ${getTokenStoreDescription()}`,
    );
  }
  return token;
}

export async function writeTokenStore(token, path) {
  await store.write(token, path);
}

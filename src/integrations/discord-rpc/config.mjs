import { homedir } from "node:os";
import { join } from "node:path";
import {
  createCredentialStore,
  defaultCredentialBackend,
} from "../../storage/credential-store.mjs";

export const DISCORD_RPC_SCOPES = ["rpc", "identify", "messages.read"];
export const DISCORD_RPC_REDIRECT_URI = "http://localhost";
export const DISCORD_OAUTH_TOKEN_URL =
  "https://discord.com/api/v10/oauth2/token";

const store = createCredentialStore({
  getBackend: getDiscordRpcCredentialBackend,
  getPath: getDiscordRpcCredentialPath,
  dpapiScript: new URL(
    "../../../scripts/discord-rpc-credential-dpapi.ps1",
    import.meta.url,
  ),
  operationName: "Discord RPC credential",
});

export function getDiscordRpcCredentialBackend() {
  if (process.env.PERSONAL_CONTEXT_DISCORD_RPC_PATH) return "file";
  if (process.env.PERSONAL_CONTEXT_DISCORD_RPC_BACKEND) {
    return process.env.PERSONAL_CONTEXT_DISCORD_RPC_BACKEND;
  }
  return defaultCredentialBackend();
}

export function getDiscordRpcCredentialPath() {
  if (process.env.PERSONAL_CONTEXT_DISCORD_RPC_PATH) {
    return process.env.PERSONAL_CONTEXT_DISCORD_RPC_PATH;
  }
  const dataRoot =
    process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(dataRoot, "personal-context-hub", "discord-rpc.json");
}

export function getDiscordRpcCredentialStoreDescription() {
  return getDiscordRpcCredentialBackend() === "dpapi"
    ? "Windows DPAPI CurrentUser: %LOCALAPPDATA%\\personal-context-hub\\discord-rpc.dpapi"
    : getDiscordRpcCredentialPath();
}

function validateCredential(credential) {
  if (!/^\d{17,20}$/.test(credential?.applicationId ?? "")) {
    throw new Error(
      "The Discord RPC credential has an invalid Application ID.",
    );
  }
  if (
    typeof credential.clientSecret !== "string" ||
    credential.clientSecret.length < 20 ||
    /\s/.test(credential.clientSecret)
  ) {
    throw new Error("The Discord RPC credential has an invalid Client Secret.");
  }
  return credential;
}

export async function readDiscordRpcCredentialStore(path) {
  let credential;
  try {
    credential = await store.read(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "Discord RPC is not configured. Store the separate Reader application's Client Secret first.",
      );
    }
    throw error;
  }
  return validateCredential(credential);
}

export async function writeDiscordRpcCredentialStore(credential, path) {
  validateCredential(credential);
  await store.write(credential, path);
}

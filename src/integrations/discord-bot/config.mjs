import { homedir } from "node:os";
import { join } from "node:path";
import {
  createCredentialStore,
  defaultCredentialBackend,
} from "../../storage/credential-store.mjs";

export const DISCORD_API_BASE = new URL("https://discord.com/api/v10/");

const store = createCredentialStore({
  getBackend: getDiscordTokenBackend,
  getPath: getDiscordTokenPath,
  dpapiScript: new URL(
    "../../../scripts/discord-token-dpapi.ps1",
    import.meta.url,
  ),
  operationName: "Discord credential",
});

export function getDiscordTokenBackend() {
  if (process.env.PERSONAL_CONTEXT_DISCORD_TOKEN_PATH) return "file";
  if (process.env.PERSONAL_CONTEXT_DISCORD_TOKEN_BACKEND) {
    return process.env.PERSONAL_CONTEXT_DISCORD_TOKEN_BACKEND;
  }
  return defaultCredentialBackend();
}

export function getDiscordTokenPath() {
  if (process.env.PERSONAL_CONTEXT_DISCORD_TOKEN_PATH) {
    return process.env.PERSONAL_CONTEXT_DISCORD_TOKEN_PATH;
  }
  const dataRoot =
    process.env.LOCALAPPDATA ?? join(homedir(), ".local", "share");
  return join(dataRoot, "personal-context-hub", "discord-bot.json");
}

export function getDiscordTokenStoreDescription() {
  return getDiscordTokenBackend() === "dpapi"
    ? "Windows DPAPI CurrentUser: %LOCALAPPDATA%\\personal-context-hub\\discord-bot.dpapi"
    : getDiscordTokenPath();
}

export async function readDiscordTokenStore(path) {
  let credential;
  try {
    credential = await store.read(path);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        "Discord is not authenticated. Store a Bot token with: npm run auth:discord -- --application-id <APPLICATION_ID>",
      );
    }
    throw error;
  }

  if (!credential.token || !credential.applicationId || !credential.botUserId) {
    throw new Error(
      `Invalid Discord credential store at ${getDiscordTokenStoreDescription()}`,
    );
  }
  return credential;
}

export async function writeDiscordTokenStore(credential, path) {
  await store.write(credential, path);
}

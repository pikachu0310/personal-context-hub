import { DiscordRpcClient } from "../src/discord-rpc-client.mjs";
import {
  getDiscordRpcCredentialStoreDescription,
  readDiscordRpcCredentialStore,
} from "../src/discord-rpc-config.mjs";

const credential = await readDiscordRpcCredentialStore();
const client = new DiscordRpcClient();
try {
  const [profile, guilds] = await Promise.all([
    client.whoami(),
    client.listGuilds(),
  ]);
  console.log(
    JSON.stringify(
      {
        applicationId: credential.applicationId,
        application: profile.application,
        user: profile.user
          ? {
              id: profile.user.id,
              username: profile.user.username,
              globalName: profile.user.global_name,
            }
          : undefined,
        scopes: profile.scopes,
        expiresAt: credential.expiresAt,
        accessibleGuildCount: guilds.length,
        credentialStore: getDiscordRpcCredentialStoreDescription(),
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}

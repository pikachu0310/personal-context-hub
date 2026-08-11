import { DiscordRpcClient } from "../src/discord-rpc-client.mjs";
import { getDiscordRpcCredentialStoreDescription } from "../src/discord-rpc-config.mjs";

const client = new DiscordRpcClient();
try {
  const session = await client.authorize();
  const guilds = await client.listGuilds();
  console.log(
    JSON.stringify(
      {
        authorized: true,
        application: session.application
          ? {
              id: session.application.id,
              name: session.application.name,
            }
          : undefined,
        user: session.user
          ? {
              id: session.user.id,
              username: session.user.username,
              globalName: session.user.global_name,
            }
          : undefined,
        scopes: session.scopes,
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

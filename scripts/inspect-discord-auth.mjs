import { DiscordClient } from "../src/discord-client.mjs";
import {
  getDiscordTokenStoreDescription,
  readDiscordTokenStore,
} from "../src/discord-config.mjs";

const credential = await readDiscordTokenStore();
const client = new DiscordClient();
const [bot, guilds] = await Promise.all([
  client.whoami(),
  client.listGuilds({ withCounts: false }),
]);

console.log(
  JSON.stringify(
    {
      applicationId: credential.applicationId,
      bot: {
        id: bot.id,
        username: bot.username,
        globalName: bot.global_name,
      },
      accessibleGuildCount: guilds.length,
      storedAt: credential.storedAt,
      tokenStore: getDiscordTokenStoreDescription(),
    },
    null,
    2,
  ),
);

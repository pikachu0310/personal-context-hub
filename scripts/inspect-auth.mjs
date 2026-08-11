import { readTokenStore } from "../src/config.mjs";
import { TraqClient } from "../src/traq-client.mjs";

const token = await readTokenStore();
const client = new TraqClient();
const [me, oidc, bots] = await Promise.all([
  client.whoami(),
  client.request("users/me/oidc"),
  client.listBots(),
]);

console.log(
  JSON.stringify(
    {
      clientId: token.clientId,
      storedScope: token.scope,
      user: { id: me.id, name: me.name, displayName: me.displayName },
      oidc: {
        sub: oidc.sub,
        name: oidc.name,
        preferredUsername: oidc.preferred_username,
      },
      hasRefreshToken: Boolean(token.refreshToken),
      expiresAt: new Date(token.expiresAt).toISOString(),
      manageableBotCount: bots.length,
    },
    null,
    2,
  ),
);

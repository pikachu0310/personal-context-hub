import {
  DISCORD_API_BASE,
  getDiscordTokenStoreDescription,
  writeDiscordTokenStore,
} from "../src/discord-config.mjs";

function getArgument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const applicationId = getArgument("--application-id");
if (!/^\d{17,20}$/.test(applicationId ?? "")) {
  throw new Error("Pass the Discord Application ID with --application-id.");
}
if (process.stdin.isTTY) {
  throw new Error(
    "Pass the Discord Bot token over stdin. Do not put it in shell history or command arguments.",
  );
}

let token = "";
for await (const chunk of process.stdin) token += chunk;
token = token.trim();
if (token.length < 30 || /\s/.test(token)) {
  throw new Error("The Discord Bot token received on stdin is invalid.");
}

const response = await fetch(new URL("users/@me", DISCORD_API_BASE), {
  headers: {
    accept: "application/json",
    authorization: `Bot ${token}`,
    "user-agent": "personal-context-hub/0.1.0",
  },
});
if (!response.ok) {
  throw new Error(`Discord rejected the Bot token (${response.status}).`);
}
const bot = await response.json();
if (!bot.bot || !/^\d{17,20}$/.test(bot.id ?? "")) {
  throw new Error("The credential did not authenticate a Discord Bot user.");
}

await writeDiscordTokenStore({
  applicationId,
  botUserId: bot.id,
  botUsername: bot.username,
  botGlobalName: bot.global_name ?? null,
  token,
  storedAt: new Date().toISOString(),
});
token = "";

console.log(
  JSON.stringify(
    {
      stored: true,
      applicationId,
      botUserId: bot.id,
      botUsername: bot.username,
      tokenStore: getDiscordTokenStoreDescription(),
    },
    null,
    2,
  ),
);

import {
  DISCORD_RPC_REDIRECT_URI,
  getDiscordRpcCredentialStoreDescription,
  writeDiscordRpcCredentialStore,
} from "../src/discord-rpc-config.mjs";

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
    "Pass the Discord Client Secret over stdin. Do not put it in shell history or command arguments.",
  );
}

let clientSecret = "";
for await (const chunk of process.stdin) clientSecret += chunk;
clientSecret = clientSecret.trim();
if (clientSecret.length < 20 || /\s/.test(clientSecret)) {
  throw new Error("The Discord Client Secret received on stdin is invalid.");
}

await writeDiscordRpcCredentialStore({
  version: 1,
  applicationId,
  clientSecret,
  redirectUri: DISCORD_RPC_REDIRECT_URI,
  storedAt: new Date().toISOString(),
});
clientSecret = "";

console.log(
  JSON.stringify(
    {
      stored: true,
      applicationId,
      redirectUri: DISCORD_RPC_REDIRECT_URI,
      credentialStore: getDiscordRpcCredentialStoreDescription(),
    },
    null,
    2,
  ),
);

// Stable CLI and compatibility exports.
import { pathToFileURL } from "node:url";
import { startDiscordVoiceCodex } from "./runtime/discord-voice.mjs";
export { startDiscordVoiceCodex };
export * from "./adapters/discord/transport.mjs";

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const service = await startDiscordVoiceCodex();
  const shutdown = async () => {
    await service.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

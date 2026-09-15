import { setTimeout as delay } from "node:timers/promises";

const codes: Record<string, string> = {
  "10003": "DISCORD_UNKNOWN_CHANNEL",
  "50001": "DISCORD_MISSING_ACCESS",
  "50013": "DISCORD_MISSING_PERMISSIONS",
  "50005": "DISCORD_CANNOT_EDIT_MESSAGE",
  "50035": "DISCORD_INVALID_MESSAGE",
  "429": "DISCORD_RATE_LIMITED",
  ECONNRESET: "ECONNRESET",
  ECONNREFUSED: "ECONNREFUSED",
  ENOTFOUND: "ENOTFOUND",
  EAI_AGAIN: "EAI_AGAIN",
  ETIMEDOUT: "ETIMEDOUT",
  UND_ERR_CONNECT_TIMEOUT: "UND_ERR_CONNECT_TIMEOUT",
};
function safeCode(error: unknown) {
  for (
    let depth = 0;
    depth < 5 && error && typeof error === "object";
    depth++
  ) {
    const detail = error as { code?: unknown; cause?: unknown };
    if (
      (typeof detail.code === "string" || typeof detail.code === "number") &&
      Object.hasOwn(codes, detail.code)
    )
      return codes[String(detail.code)];
    error = detail.cause;
  }
}
const retryable = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

// GET and edits of a known message are safe to repeat after connection loss.
// A send is not: Discord may have created the message before the socket failed.
async function readOrEdit<T>(
  operation: () => Promise<T>,
  isCurrent: () => boolean,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!isCurrent()) return;
    try {
      return await operation();
    } catch (error) {
      if (attempt || !retryable.has(safeCode(error) ?? "")) throw error;
      await delay(250);
    }
  }
}

// Serialize edits per card so simultaneous speakers do not create duplicate messages.
export class Publications {
  private queues = new Map<string, Promise<void>>();
  private ids = new Map<string, string>();
  constructor(
    readonly fetchChannel: (id: string) => Promise<any>,
    readonly saved: (key: string, messageId: string) => void | Promise<void>,
  ) {}
  update(
    key: string,
    channelId: string,
    content: string,
    savedId?: string,
    isCurrent: () => boolean = () => true,
  ) {
    const next = (this.queues.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const channel = await readOrEdit(
          () => this.fetchChannel(channelId),
          isCurrent,
        );
        if (!isCurrent()) return;
        if (!channel?.isTextBased() || !channel.send) return;
        const payload = {
          content: content.slice(0, 1900),
          allowedMentions: { parse: [] },
        };
        const messageId = this.ids.get(key) ?? savedId;
        if (messageId) {
          try {
            await readOrEdit(
              () => channel.messages.edit(messageId, payload),
              isCurrent,
            );
            if (!isCurrent()) return;
            this.ids.set(key, messageId);
            return;
          } catch (error: any) {
            // Only a deleted message warrants a replacement. Do not duplicate on rate limits/network errors.
            if (error?.code !== 10008) throw error;
          }
        }
        if (!isCurrent()) return;
        const message = await channel.send(payload);
        this.ids.set(key, message.id);
        await this.saved(key, message.id);
      })
      .catch((error: unknown) => {
        // RPC accepts symbolic errors only. Never forward Discord payloads,
        // which may contain message text or request credentials.
        const code = safeCode(error);
        if (code) throw new Error(code);
        throw error;
      });
    this.queues.set(key, next);
    void next
      .finally(() => {
        if (this.queues.get(key) === next) this.queues.delete(key);
      })
      .catch(() => {});
    return next;
  }
}

import { secret, hash } from "../../common/src/platform.js";
import { Store } from "./store.js";
import { Credentials } from "../../common/src/credentials.js";
import { HttpError } from "../../common/src/http.js";
export class DiscordAuth {
  states = new Map<string, { userId: string; expires: number }>();
  tokens = new Map<string, { userId: string; expires: number }>();
  constructor(
    readonly store: Store,
    readonly credentials: Credentials,
    readonly request: (
      operation: string,
      input: Record<string, unknown>,
    ) => Promise<any>,
  ) {}
  config() {
    return this.store.get<Record<string, string>>("config", "discord") ?? {};
  }
  start(userId: string, origin: string) {
    const state = secret();
    this.states.set(state, { userId, expires: Date.now() + 5 * 60000 });
    const url = new URL("https://discord.com/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: this.config().appId,
      response_type: "code",
      redirect_uri: origin + "/api/discord/callback",
      scope: "identify",
      state,
    }).toString();
    return url.href;
  }
  async exchange(code: string, redirectUri?: string) {
    const config = this.config(),
      clientSecret = await this.credentials.get("discord.clientSecret");
    if (!config.appId || !clientSecret)
      throw new HttpError(400, "DISCORD_OAUTH_NOT_CONFIGURED");
    return this.request("oauth.exchange", {
      code,
      redirectUri,
      appId: config.appId,
      clientSecret,
    }) as Promise<{ user: { id: string }; accessToken: string }>;
  }

  async callback(state: string, code: string, origin: string) {
    const pending = this.states.get(state);
    this.states.delete(state);
    if (!pending || pending.expires < Date.now())
      throw new HttpError(401, "OAUTH_STATE_EXPIRED");
    const { user } = await this.exchange(
      code,
      origin + "/api/discord/callback",
    );
    const existing = this.store.get<{ userId: string }>(
      "discord-user",
      user.id,
    );
    if (existing && existing.userId !== pending.userId)
      throw new HttpError(409, "DISCORD_ALREADY_LINKED");
    this.store.put("discord-user", user.id, { userId: pending.userId });
    this.store.audit(pending.userId, "discord.link", "self");
  }
  async activity(code: string) {
    const { user, accessToken } = await this.exchange(code);
    const linked = this.store.get<{ userId: string }>("discord-user", user.id);
    if (!linked || !this.store.user(linked.userId))
      throw new HttpError(403, "LINK_DISCORD_IN_DASHBOARD_FIRST");
    const token = secret();
    for (const [key, value] of this.tokens)
      if (value.expires < Date.now()) this.tokens.delete(key);
    this.tokens.set(hash(token), {
      userId: linked.userId,
      expires: Date.now() + 3600000,
    });
    return { token, accessToken };
  }
  user(token: string) {
    const session = this.tokens.get(hash(token));
    const user =
      session && session.expires > Date.now()
        ? this.store.user(session.userId)
        : undefined;
    if (!user) throw new HttpError(401, "ACTIVITY_LOGIN_REQUIRED");
    return user;
  }
}

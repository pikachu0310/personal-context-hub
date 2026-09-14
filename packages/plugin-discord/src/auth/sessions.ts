import { randomUUID } from "node:crypto";
import type { Rpc } from "@ido/common/runtime/rpc";
import { exchange } from "./exchange.js";
export class DiscordAuth {
  states = new Map<
    string,
    { context: string; origin: string; expires: number }
  >();
  constructor(
    readonly config: () => Record<string, string>,
    readonly rpc: () => Rpc,
    readonly exchangeCode = exchange,
  ) {}
  start(context: string, origin: string) {
    for (const [key, value] of this.states)
      if (value.expires < Date.now()) this.states.delete(key);
    const state = randomUUID();
    this.states.set(state, { context, origin, expires: Date.now() + 300000 });
    const url = new URL("https://discord.com/oauth2/authorize");
    url.search = new URLSearchParams({
      client_id: this.config().appId,
      response_type: "code",
      redirect_uri: origin + "/plugins/discord/callback",
      scope: "identify",
      state,
    }).toString();
    return url.href;
  }
  async callback(state: string, code: string) {
    const pending = this.states.get(state);
    this.states.delete(state);
    if (!pending || pending.expires < Date.now())
      throw new Error("OAUTH_STATE_EXPIRED");
    const result = await this.exchangeCode({
      ...this.config(),
      code,
      redirectUri: pending.origin + "/plugins/discord/callback",
    });
    await this.rpc().request(
      "identity.link",
      { subject: result.user.id },
      pending.context,
    );
  }
  async activity(code: string) {
    const { user, accessToken } = await this.exchangeCode({
      ...this.config(),
      code,
    });
    const { token } = await this.rpc().request<{ token: string }>(
      "identity.session",
      { subject: user.id },
    );
    return { token, accessToken };
  }
}

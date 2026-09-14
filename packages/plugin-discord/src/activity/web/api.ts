let token = "";
let authentication: Promise<void> | undefined;
const base = "/plugins/discord/api/activity/";
async function authenticate() {
  const config = (await (await fetch(base + "config")).json()) as {
    appId: string;
  };
  const { DiscordSDK } = await import("@discord/embedded-app-sdk");
  const sdk = new DiscordSDK(config.appId);
  await sdk.ready();
  const { code } = await sdk.commands.authorize({
    client_id: config.appId,
    response_type: "code",
    state: crypto.randomUUID(),
    prompt: "none",
    scope: ["identify"],
  });
  const response = await fetch(base + "auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const result = (await response.json()) as {
    token: string;
    accessToken: string;
    error?: string;
  };
  if (!response.ok) throw new Error(result.error ?? "ACTIVITY_LOGIN_REQUIRED");
  await sdk.commands.authenticate({ access_token: result.accessToken });
  token = result.token;
}
export async function api<T>(
  path: string,
  input?: Record<string, unknown>,
): Promise<T> {
  await (authentication ??= authenticate().catch((error) => {
    authentication = undefined;
    throw error;
  }));
  const operation =
    (
      { messages: "message", "task/control": "control" } as Record<
        string,
        string
      >
    )[path] ?? path;
  const response = await fetch(base + operation, {
    method: input ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: input ? JSON.stringify(input) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) authentication = undefined;
    throw new Error(result.error ?? "REQUEST_FAILED");
  }
  return result as T;
}

export async function exchange(input: Record<string, string>) {
  const response = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: input.appId,
      client_secret: input.clientSecret,
      grant_type: "authorization_code",
      code: input.code,
      ...(input.redirectUri ? { redirect_uri: input.redirectUri } : {}),
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("OAUTH_FAILED");
  const token = (await response.json()) as { access_token: string };
  const identity = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!identity.ok) throw new Error("IDENTITY_FAILED");
  const user = (await identity.json()) as { id: string };
  return { user, accessToken: token.access_token };
}

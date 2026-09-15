export const releasePage =
  "https://github.com/pikachu0310/personal-context-hub-discord-voice/releases/latest";
export async function checkUpdate(
  current: string,
  request: typeof fetch = fetch,
) {
  const response = await request(
    "https://api.github.com/repos/pikachu0310/personal-context-hub-discord-voice/releases/latest",
    {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (response.status === 404) return { current, status: "unpublished" };
  if (!response.ok) throw new Error("UPDATE_CHECK_FAILED");
  const release = (await response.json()) as {
    tag_name?: string;
    draft?: boolean;
    prerelease?: boolean;
  };
  const latest = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name ?? "")?.[1];
  if (!latest || release.draft || release.prerelease)
    throw new Error("INVALID_RELEASE");
  const a = latest.split(".").map(Number),
    b = current.split(".").map(Number);
  const difference = a.map((n, i) => n - (b[i] ?? 0)).find((n) => n !== 0) ?? 0;
  return { current, latest, status: difference > 0 ? "available" : "current" };
}

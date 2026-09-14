const CONTEXT_URL = process.env.PUBLIC_CONTEXT_URL;
const EXPECTED_DISPLAY_NAME = process.env.PUBLIC_CONTEXT_DISPLAY_NAME;

if (!CONTEXT_URL) {
  throw new Error("Set PUBLIC_CONTEXT_URL to a public JSON context endpoint.");
}

const response = await fetch(CONTEXT_URL, {
  headers: { accept: "application/json" },
});
if (!response.ok) {
  throw new Error(
    `Public context request failed (${response.status} ${response.statusText}).`,
  );
}

const context = await response.json();
if (
  context.canonical !== CONTEXT_URL ||
  typeof context.schemaVersion !== "string" ||
  !context.generatedFrom?.contentReviewedAt ||
  (EXPECTED_DISPLAY_NAME &&
    context.data?.identity?.displayName !== EXPECTED_DISPLAY_NAME) ||
  !Array.isArray(context.data?.primaryDomains)
) {
  throw new Error("The endpoint returned an unexpected context contract.");
}

console.log(
  JSON.stringify(
    {
      connected: true,
      canonical: context.canonical,
      schemaVersion: context.schemaVersion,
      contentRevision: context.generatedFrom.contentRevision,
      contentReviewedAt: context.generatedFrom.contentReviewedAt,
      deploymentRevision: context.generatedFrom.deploymentRevision,
      displayName: context.data.identity.displayName,
      primaryDomains: context.data.primaryDomains.map(({ id, title }) => ({
        id,
        title,
      })),
      featuredWorkCount: context.data.featuredWorks?.length ?? 0,
      publicOnly: true,
      cachedInRepository: false,
    },
    null,
    2,
  ),
);

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  TRAQ_CALLBACK_PORT,
  TRAQ_OAUTH_SCOPES,
  TRAQ_ORIGIN,
  TRAQ_REDIRECT_URI,
  getTokenStoreDescription,
  readTokenStore,
} from "./config.mjs";
import { exchangeAuthorizationCode } from "./traq-client.mjs";

function parseClientId(argv) {
  const index = argv.indexOf("--client-id");
  return index >= 0 ? argv[index + 1] : process.env.TRAQ_CLIENT_ID;
}

function base64url(buffer) {
  return buffer.toString("base64url");
}

let clientId = parseClientId(process.argv.slice(2));
if (!clientId) {
  try {
    clientId = (await readTokenStore()).clientId;
  } catch {
    // First-time authentication still requires an explicit public Client ID.
  }
}
if (!clientId) {
  console.error("Usage: npm run auth:traq -- --client-id <CLIENT_ID>");
  process.exit(2);
}

const state = base64url(randomBytes(24));
const codeVerifier = base64url(randomBytes(48));
const codeChallenge = base64url(
  createHash("sha256").update(codeVerifier).digest(),
);
const authorizeUrl = new URL("/api/v3/oauth2/authorize", TRAQ_ORIGIN);
authorizeUrl.search = new URLSearchParams({
  response_type: "code",
  client_id: clientId,
  redirect_uri: TRAQ_REDIRECT_URI,
  scope: TRAQ_OAUTH_SCOPES.join(" "),
  state,
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
}).toString();

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", TRAQ_REDIRECT_URI);
  if (requestUrl.pathname !== "/oauth/callback") {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
    return;
  }

  try {
    if (requestUrl.searchParams.get("state") !== state) {
      throw new Error("OAuth state mismatch.");
    }
    const code = requestUrl.searchParams.get("code");
    if (!code) {
      throw new Error(
        requestUrl.searchParams.get("error") ??
          "Authorization code is missing.",
      );
    }
    await exchangeAuthorizationCode({ clientId, code, codeVerifier });
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      "<!doctype html><meta charset=utf-8><title>traQ connected</title><h1>traQの接続が完了しました</h1><p>このタブを閉じて構いません。</p>",
    );
    console.log(
      `Authenticated. Token stored at: ${getTokenStoreDescription()}`,
    );
    setTimeout(() => server.close(() => process.exit(0)), 100);
  } catch (error) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end(`Authentication failed: ${error.message}`);
    console.error(error.message);
    setTimeout(() => server.close(() => process.exit(1)), 100);
  }
});

server.listen(TRAQ_CALLBACK_PORT, "127.0.0.1", () => {
  console.log("Open this URL in the logged-in traQ browser:");
  console.log(authorizeUrl.toString());
  console.log(`Waiting for callback on ${TRAQ_REDIRECT_URI}`);
});

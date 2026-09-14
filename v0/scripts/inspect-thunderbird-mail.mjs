import { ThunderbirdMailClient } from "../src/integrations/thunderbird/client.mjs";

const client = new ThunderbirdMailClient();
const status = client.profileStatus();
const accounts = client.listAccounts();

console.log(
  JSON.stringify(
    {
      available: status.available,
      readOnly: status.readOnly,
      databaseUpdatedAt: status.databaseUpdatedAt,
      accountCount: status.accountCount,
      accounts: accounts.map((account) => ({
        email: account.email,
        indexedMessages: account.indexedMessages,
        newestIndexedAt: account.newestIndexedAt,
      })),
    },
    null,
    2,
  ),
);

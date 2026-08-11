import { TraqClient } from "../src/traq-client.mjs";

const client = new TraqClient();
const me = await client.whoami();
const recent = await client.searchMessages({
  fromUserIds: [me.id],
  limit: 15,
  offset: 0,
  sort: "createdAt",
});

console.log(
  JSON.stringify(
    {
      user: { id: me.id, name: me.name, displayName: me.displayName },
      totalHits: recent.totalHits,
      posts: recent.hits,
    },
    null,
    2,
  ),
);

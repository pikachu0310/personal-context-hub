import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  accountFolderPrefix,
  parseThunderbirdAccounts,
  parseThunderbirdProfiles,
} from "../src/thunderbird-config.mjs";
import { ThunderbirdMailClient } from "../src/thunderbird-mail-client.mjs";

const prefs = `
user_pref("mail.server.server2.hostname", "imap.gmail.com");
user_pref("mail.server.server2.name", "person@example.com");
user_pref("mail.server.server2.type", "imap");
user_pref("mail.server.server2.userName", "person@example.com");
user_pref("mail.server.server2.directory-rel", "[ProfD]ImapMail/imap.gmail.com");
user_pref("mail.server.server3.hostname", "Local Folders");
user_pref("mail.server.server3.name", "Local Folders");
user_pref("mail.server.server3.type", "none");
user_pref("mail.server.server3.userName", "nobody");
`;

test("parseThunderbirdAccounts returns IMAP accounts only", () => {
  assert.deepEqual(parseThunderbirdAccounts(prefs), [
    {
      id: "server2",
      email: "person@example.com",
      username: "person@example.com",
      hostname: "imap.gmail.com",
      type: "imap",
      storeRelativePath: "ImapMail/imap.gmail.com",
    },
  ]);
});

test("accountFolderPrefix encodes the Thunderbird IMAP username", () => {
  assert.equal(
    accountFolderPrefix({
      username: "person@example.com",
      hostname: "imap.gmail.com",
    }),
    "imap://person%40example.com@imap.gmail.com",
  );
});

test("parseThunderbirdProfiles keeps profile paths and default markers", () => {
  assert.deepEqual(
    parseThunderbirdProfiles(`
[Profile0]
Name=default
IsRelative=1
Path=Profiles/example.default-release
Default=1

[InstallABC]
Default=Profiles/example.default-release
`),
    [
      {
        section: "Profile0",
        Name: "default",
        IsRelative: "1",
        Path: "Profiles/example.default-release",
        Default: "1",
      },
    ],
  );
});

test("ThunderbirdMailClient searches and reads only the selected account", async () => {
  const profilePath = await mkdtemp(join(tmpdir(), "thunderbird-mail-test-"));
  try {
    await mkdir(join(profilePath, "ImapMail", "imap.gmail.com"), {
      recursive: true,
    });
    await writeFile(join(profilePath, "prefs.js"), prefs);

    const databasePath = join(profilePath, "global-messages-db.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE folderLocations (
        id INTEGER PRIMARY KEY,
        folderURI TEXT,
        dirtyStatus INTEGER,
        name TEXT,
        indexingPriority INTEGER
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        folderID INTEGER,
        messageKey INTEGER,
        conversationID INTEGER,
        date INTEGER,
        headerMessageID TEXT,
        deleted INTEGER,
        jsonAttributes TEXT,
        notability INTEGER
      );
      CREATE TABLE messagesText_content (
        docid INTEGER PRIMARY KEY,
        c0body TEXT,
        c1subject TEXT,
        c2attachmentNames TEXT,
        c3author TEXT,
        c4recipients TEXT
      );
    `);
    db.prepare(
      "INSERT INTO folderLocations (id, folderURI, name) VALUES (?, ?, ?)",
    ).run(1, "imap://person%40example.com@imap.gmail.com/INBOX", "INBOX");
    db.prepare(
      "INSERT INTO messages (id, folderID, date, headerMessageID, deleted) VALUES (?, ?, ?, ?, ?)",
    ).run(
      10,
      1,
      Date.parse("2026-07-23T01:00:00Z") * 1000,
      "message@example",
      0,
    );
    db.prepare(
      "INSERT INTO messagesText_content (docid, c0body, c1subject, c2attachmentNames, c3author, c4recipients) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      10,
      "The private body contains a deadline.",
      "Project deadline",
      "",
      "Sender <sender@example.com>",
      "person@example.com",
    );
    db.close();

    const client = new ThunderbirdMailClient({ profilePath });
    const results = client.searchMessages({
      account: "person@example.com",
      query: "deadline",
      limit: 5,
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].localMessageId, 10);
    assert.match(results[0].bodySnippet, /private body/);
    assert.equal(
      client.searchMessages({
        account: "person@example.com",
        query: "deadline",
        snippetChars: 0,
      })[0].bodySnippet,
      "",
    );

    const message = client.readMessage({
      account: "person@example.com",
      localMessageId: 10,
    });
    assert.equal(message.subject, "Project deadline");
    assert.equal(message.body, "The private body contains a deadline.");
    assert.throws(() =>
      client.readMessage({
        account: "other@example.com",
        localMessageId: 10,
      }),
    );
  } finally {
    await rm(profilePath, { recursive: true, force: true });
  }
});

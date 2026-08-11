import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  accountFolderPrefix,
  getThunderbirdProfilePath,
  readThunderbirdAccounts,
} from "./thunderbird-config.mjs";

const MAX_BODY_CHARS = 40_000;
const MAX_SNIPPET_CHARS = 800;

function toIsoDate(glodaMicroseconds) {
  if (!glodaMicroseconds) return null;
  return new Date(Number(glodaMicroseconds) / 1000).toISOString();
}

function normalizeText(value) {
  return typeof value === "string" ? value : "";
}

function compactSnippet(value, maxChars = 400) {
  if (maxChars <= 0) return "";
  const normalized = normalizeText(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

function escapeLike(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

function dateToGloda(value, fieldName) {
  if (!value) return undefined;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${fieldName} must be an ISO-8601 datetime.`);
  }
  return milliseconds * 1000;
}

export class ThunderbirdMailClient {
  constructor({ profilePath = getThunderbirdProfilePath() } = {}) {
    this.profilePath = profilePath;
  }

  get databasePath() {
    return join(this.profilePath, "global-messages-db.sqlite");
  }

  getAccounts() {
    return readThunderbirdAccounts(this.profilePath);
  }

  getAccount(email) {
    const account = this.getAccounts().find(
      (candidate) => candidate.email.toLowerCase() === email.toLowerCase(),
    );
    if (!account) {
      throw new Error(
        `Unknown Thunderbird account: ${email}. Call thunderbird_list_accounts first.`,
      );
    }
    return account;
  }

  openDatabase() {
    if (!existsSync(this.databasePath)) {
      throw new Error(
        `Thunderbird global message index was not found at ${this.databasePath}.`,
      );
    }
    return new DatabaseSync(this.databasePath, {
      open: true,
      readOnly: true,
      allowExtension: false,
      readBigInts: false,
      timeout: 5000,
    });
  }

  profileStatus() {
    const accounts = this.getAccounts();
    const database = statSync(this.databasePath);
    return {
      available: true,
      profilePath: this.profilePath,
      databasePath: this.databasePath,
      databaseBytes: database.size,
      databaseUpdatedAt: database.mtime.toISOString(),
      accountCount: accounts.length,
      readOnly: true,
    };
  }

  listAccounts() {
    const db = this.openDatabase();
    try {
      return this.getAccounts().map((account) => {
        const prefix = accountFolderPrefix(account);
        const counts = db
          .prepare(
            `SELECT
               COUNT(*) AS indexedMessages,
               MAX(m.date) AS newestDate
             FROM messages m
             JOIN folderLocations f ON f.id = m.folderID
             WHERE m.deleted = 0
               AND (f.folderURI = ? OR f.folderURI LIKE ? ESCAPE '\\')`,
          )
          .get(prefix, `${escapeLike(prefix)}/%`);
        return {
          email: account.email,
          hostname: account.hostname,
          indexedMessages: Number(counts.indexedMessages ?? 0),
          newestIndexedAt: toIsoDate(counts.newestDate),
        };
      });
    } finally {
      db.close();
    }
  }

  listFolders(email) {
    const account = this.getAccount(email);
    const prefix = accountFolderPrefix(account);
    const db = this.openDatabase();
    try {
      return db
        .prepare(
          `SELECT
             f.folderURI AS folderUri,
             f.name AS name,
             COUNT(m.id) AS indexedMessages,
             MAX(m.date) AS newestDate
           FROM folderLocations f
           LEFT JOIN messages m ON m.folderID = f.id AND m.deleted = 0
           WHERE f.folderURI = ? OR f.folderURI LIKE ? ESCAPE '\\'
           GROUP BY f.id
           ORDER BY f.folderURI`,
        )
        .all(prefix, `${escapeLike(prefix)}/%`)
        .map((row) => ({
          folder: row.folderUri.slice(prefix.length + 1),
          name: row.name,
          indexedMessages: Number(row.indexedMessages ?? 0),
          newestIndexedAt: toIsoDate(row.newestDate),
        }));
    } finally {
      db.close();
    }
  }

  searchMessages({
    account: email,
    folder = "INBOX",
    query,
    from,
    to,
    after,
    before,
    limit = 20,
    snippetChars = 400,
  }) {
    const account = this.getAccount(email);
    const prefix = accountFolderPrefix(account);
    const conditions = [
      "m.deleted = 0",
      "(f.folderURI = ? OR f.folderURI LIKE ? ESCAPE '\\')",
    ];
    const params = [prefix, `${escapeLike(prefix)}/%`];

    if (folder) {
      conditions.push("f.folderURI = ?");
      params.push(`${prefix}/${folder}`);
    }

    const addTextFilter = (column, value) => {
      if (!value) return;
      conditions.push(`LOWER(COALESCE(${column}, '')) LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(value.toLowerCase())}%`);
    };

    if (query) {
      conditions.push(
        `(LOWER(COALESCE(t.c0body, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(t.c1subject, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(t.c3author, '')) LIKE ? ESCAPE '\\'
          OR LOWER(COALESCE(t.c4recipients, '')) LIKE ? ESCAPE '\\')`,
      );
      const pattern = `%${escapeLike(query.toLowerCase())}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    addTextFilter("t.c3author", from);
    addTextFilter("t.c4recipients", to);

    const afterValue = dateToGloda(after, "after");
    if (afterValue !== undefined) {
      conditions.push("m.date >= ?");
      params.push(afterValue);
    }
    const beforeValue = dateToGloda(before, "before");
    if (beforeValue !== undefined) {
      conditions.push("m.date < ?");
      params.push(beforeValue);
    }

    params.push(limit);
    const db = this.openDatabase();
    try {
      return db
        .prepare(
          `SELECT
             m.id AS localMessageId,
             m.date AS date,
             m.headerMessageID AS headerMessageId,
             f.folderURI AS folderUri,
             t.c1subject AS subject,
             t.c3author AS author,
             t.c4recipients AS recipients,
             t.c2attachmentNames AS attachmentNames,
             t.c0body AS body
           FROM messages m
           JOIN folderLocations f ON f.id = m.folderID
           JOIN messagesText_content t ON t.docid = m.id
           WHERE ${conditions.join("\n AND ")}
           ORDER BY m.date DESC
           LIMIT ?`,
        )
        .all(...params)
        .map((row) => ({
          localMessageId: Number(row.localMessageId),
          account: account.email,
          folder: row.folderUri.slice(prefix.length + 1),
          date: toIsoDate(row.date),
          headerMessageId: row.headerMessageId || null,
          subject: normalizeText(row.subject),
          author: normalizeText(row.author),
          recipients: normalizeText(row.recipients),
          attachmentNames: normalizeText(row.attachmentNames),
          bodySnippet: compactSnippet(
            row.body,
            Math.min(snippetChars, MAX_SNIPPET_CHARS),
          ),
        }));
    } finally {
      db.close();
    }
  }

  readMessage({ account: email, localMessageId, maxBodyChars = 20_000 }) {
    const account = this.getAccount(email);
    const prefix = accountFolderPrefix(account);
    const db = this.openDatabase();
    try {
      const row = db
        .prepare(
          `SELECT
             m.id AS localMessageId,
             m.date AS date,
             m.headerMessageID AS headerMessageId,
             f.folderURI AS folderUri,
             t.c1subject AS subject,
             t.c3author AS author,
             t.c4recipients AS recipients,
             t.c2attachmentNames AS attachmentNames,
             t.c0body AS body
           FROM messages m
           JOIN folderLocations f ON f.id = m.folderID
           JOIN messagesText_content t ON t.docid = m.id
           WHERE m.id = ?
             AND m.deleted = 0
             AND (f.folderURI = ? OR f.folderURI LIKE ? ESCAPE '\\')`,
        )
        .get(localMessageId, prefix, `${escapeLike(prefix)}/%`);

      if (!row) {
        throw new Error(
          `Message ${localMessageId} was not found in Thunderbird account ${email}.`,
        );
      }

      const body = normalizeText(row.body);
      const bodyLimit = Math.min(maxBodyChars, MAX_BODY_CHARS);
      return {
        localMessageId: Number(row.localMessageId),
        account: account.email,
        folder: row.folderUri.slice(prefix.length + 1),
        date: toIsoDate(row.date),
        headerMessageId: row.headerMessageId || null,
        subject: normalizeText(row.subject),
        author: normalizeText(row.author),
        recipients: normalizeText(row.recipients),
        attachmentNames: normalizeText(row.attachmentNames),
        body: body.length <= bodyLimit ? body : `${body.slice(0, bodyLimit)}…`,
        bodyTruncated: body.length > bodyLimit,
        source: "Thunderbird local search index",
      };
    } finally {
      db.close();
    }
  }
}

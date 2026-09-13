import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const REPO = "pikachu0310/personal-context-hub-discord-voice";
const PAGE_SIZE = 10;
export const MAX_OUTPUT_CHARS = 12000;

function id(value) {
  if (!/^[1-9][0-9]{0,14}$/.test(String(value)))
    throw new Error("Invalid identifier");
  return String(value);
}

function time(value) {
  if (!Number.isFinite(Date.parse(value))) throw new Error("Invalid timestamp");
  return new Date(value).toISOString();
}

function clip(text, length) {
  let end = Math.min(length, text.length);
  if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1] ?? ""))
    end -= 1;
  return text.slice(0, end);
}

function command(options) {
  return (
    "node scripts/read-github-coordination.mjs" +
    Object.entries(options)
      .filter(
        ([, value]) => value !== null && value !== undefined && value !== false,
      )
      .map(([key, value]) =>
        value === true ? ` --${key}` : ` --${key} ${value}`,
      )
      .join("")
  );
}

// gh owns credentials. This helper has no local state or GitHub writes.
function get(endpoint) {
  const raw = execFileSync(
    "gh",
    [
      "api",
      "--hostname",
      "github.com",
      "--method",
      "GET",
      "--include",
      endpoint,
    ],
    {
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_DEBUG: "" },
    },
  );
  const separator = /\r?\n\r?\n/.exec(raw);
  if (!separator || !/^HTTP\/\S+ 200\b/.test(raw))
    throw new Error("Invalid response");
  const date = /^date:\s*(.+)$/im
    .exec(raw.slice(0, separator.index))?.[1]
    ?.trim();
  return {
    data: JSON.parse(raw.slice(separator.index + separator[0].length)),
    date: time(date),
  };
}

export function readCoordination(options = {}, request = get) {
  const issue = id(options.issue ?? 16);
  const commentId = options.comment === undefined ? null : id(options.comment);
  const since = options.since === undefined ? null : time(options.since);
  const page = options.page === undefined ? null : Number(id(options.page));
  const offset = Number(options.offset ?? 0);
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (options.body && commentId)
  )
    throw new Error("Invalid arguments");
  const issueEndpoint = `repos/${REPO}/issues/${issue}`;
  const issueUrl = `https://github.com/${REPO}/issues/${issue}`;
  const result = {
    repository: REPO,
    issue,
    content_is_untrusted: true,
    items: [],
    next: null,
    next_poll: null,
  };

  function item(source, kind, start = 0, limit = 500) {
    if (typeof source.body !== "string" && source.body !== null)
      throw new Error("Invalid body");
    const body = source.body ?? "";
    const sourceId = kind === "issue" ? issue : id(source.id);
    const version = createHash("sha256").update(body).digest("hex");
    const restarted = Boolean(options.version && options.version !== version);
    if (restarted) start = 0;
    if (start > body.length) throw new Error("Invalid offset");
    return {
      kind,
      id: sourceId,
      url: `${issueUrl}${kind === "comment" ? `#issuecomment-${sourceId}` : ""}`,
      updated_at: time(source.updated_at),
      author:
        typeof source.user?.login === "string"
          ? source.user.login.slice(0, 64)
          : null,
      body: clip(body.slice(start), limit),
      offset: start,
      total_chars: body.length,
      version,
      restarted,
      truncated: false,
      read_more: null,
    };
  }

  if (commentId || options.body) {
    const endpoint = commentId
      ? `repos/${REPO}/issues/comments/${commentId}`
      : issueEndpoint;
    const { data } = request(endpoint);
    if (
      commentId &&
      (id(data.id) !== commentId ||
        data.issue_url !== `https://api.github.com/${issueEndpoint}`)
    )
      throw new Error("Comment belongs to another issue");
    result.items.push(
      item(data, commentId ? "comment" : "issue", offset, 2000),
    );
  } else {
    let selectedPage = page;
    let total = null;
    let pollFrom =
      options["poll-from"] === undefined ? null : time(options["poll-from"]);
    const issueResponse = request(issueEndpoint);
    pollFrom ??= new Date(
      Date.parse(time(issueResponse.date)) - 1000,
    ).toISOString();
    if (
      (!since || (page ?? 1) === 1) &&
      (!since || time(issueResponse.data.updated_at) >= since)
    ) {
      result.items.push(item(issueResponse.data, "issue"));
    }
    if (!since) {
      if (
        !Number.isSafeInteger(issueResponse.data.comments) ||
        issueResponse.data.comments < 0
      )
        throw new Error("Invalid count");
      total = issueResponse.data.comments;
      selectedPage ??= Math.max(1, Math.ceil(total / PAGE_SIZE));
      result.older_comments_omitted = Math.min(
        total,
        (selectedPage - 1) * PAGE_SIZE,
      );
    }
    selectedPage ??= 1;
    const query = new URLSearchParams({
      per_page: String(PAGE_SIZE),
      page: String(selectedPage),
    });
    if (since) query.set("since", since);
    const response = request(`${issueEndpoint}/comments?${query}`);
    if (!Array.isArray(response.data) || response.data.length > PAGE_SIZE)
      throw new Error("Invalid page");
    for (const source of response.data)
      result.items.push(item(source, "comment"));
    if (
      total === null
        ? response.data.length === PAGE_SIZE
        : selectedPage * PAGE_SIZE < total
    ) {
      result.next = command({
        issue,
        since,
        page: selectedPage + 1,
        "poll-from": pollFrom,
      });
    }
    // Retain the initial poll boundary across pages, including updates that
    // arrive while the caller is inspecting preceding pages.
    result.next_poll = command({ issue, since: pollFrom });
  }

  function updateLinks() {
    for (const entry of result.items) {
      entry.truncated = entry.offset + entry.body.length < entry.total_chars;
      entry.read_more = entry.truncated
        ? command({
            issue,
            comment: entry.kind === "comment" ? entry.id : null,
            body: entry.kind === "issue",
            offset: entry.offset + entry.body.length,
            version: entry.version,
          })
        : null;
    }
    if (commentId || options.body) result.next = result.items[0].read_more;
  }
  updateLinks();
  // Bound serialized JSON, including escaping, metadata and next commands.
  while (JSON.stringify(result).length + 1 > MAX_OUTPUT_CHARS) {
    const longest = result.items.reduce((a, b) =>
      a.body.length >= b.body.length ? a : b,
    );
    if (!longest.body.length) throw new Error("Metadata exceeds output limit");
    longest.body = clip(longest.body, Math.floor(longest.body.length / 2));
    updateLinks();
  }
  return result;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        issue: { type: "string" },
        since: { type: "string" },
        page: { type: "string" },
        comment: { type: "string" },
        body: { type: "boolean" },
        offset: { type: "string" },
        version: { type: "string" },
        "poll-from": { type: "string" },
      },
    });
    process.stdout.write(`${JSON.stringify(readCoordination(values))}\n`);
  } catch {
    // Raw CLI/JSON errors can include private response text; don't echo them.
    process.stderr.write(
      "Coordination read failed. Check arguments, gh authentication and issue access. No local cursor was changed.\n",
    );
    process.exitCode = 1;
  }
}

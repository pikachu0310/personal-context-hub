import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function parsePreferenceValue(value) {
  try {
    return JSON.parse(`"${value}"`);
  } catch {
    return value;
  }
}

export function parseThunderbirdAccounts(prefsText) {
  const servers = new Map();
  const pattern =
    /^user_pref\("mail\.server\.(server\d+)\.(hostname|name|type|userName|directory-rel)",\s*"((?:\\.|[^"])*)"\);$/gm;

  for (const match of prefsText.matchAll(pattern)) {
    const [, serverId, key, rawValue] = match;
    const server = servers.get(serverId) ?? { serverId };
    server[key] = parsePreferenceValue(rawValue);
    servers.set(serverId, server);
  }

  return [...servers.values()]
    .filter(
      (server) =>
        server.type === "imap" &&
        server.hostname &&
        server.userName &&
        server.name &&
        server["directory-rel"],
    )
    .map((server) => ({
      id: server.serverId,
      email: server.name,
      username: server.userName,
      hostname: server.hostname,
      type: server.type,
      storeRelativePath: server["directory-rel"].replace(/^\[ProfD\]/, ""),
    }))
    .sort((left, right) => left.email.localeCompare(right.email));
}

export function parseThunderbirdProfiles(profilesText) {
  const profiles = [];
  let current;

  for (const rawLine of profilesText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = /^Profile\d+$/.test(section[1])
        ? { section: section[1] }
        : undefined;
      if (current) profiles.push(current);
      continue;
    }
    if (!current || !line || line.startsWith("#") || !line.includes("=")) {
      continue;
    }
    const separator = line.indexOf("=");
    current[line.slice(0, separator)] = line.slice(separator + 1);
  }

  return profiles.filter((profile) => profile.Path);
}

function findThunderbirdProfile(profilesRoot) {
  if (existsSync(join(profilesRoot, "prefs.js"))) return profilesRoot;

  const profilesIni = join(profilesRoot, "profiles.ini");
  if (!existsSync(profilesIni)) return undefined;
  const profiles = parseThunderbirdProfiles(readFileSync(profilesIni, "utf8"));
  const ordered = [
    ...profiles.filter((profile) => profile.Default === "1"),
    ...profiles.filter((profile) => profile.Default !== "1"),
  ];

  for (const profile of ordered) {
    const path =
      profile.IsRelative === "0"
        ? profile.Path
        : join(profilesRoot, profile.Path);
    if (existsSync(join(path, "prefs.js"))) return path;
  }
  return undefined;
}

export function getThunderbirdProfilePath() {
  if (process.env.THUNDERBIRD_PROFILE) {
    return process.env.THUNDERBIRD_PROFILE;
  }

  const roots = [
    process.env.THUNDERBIRD_PROFILES_ROOT,
    process.platform === "win32" && process.env.APPDATA
      ? join(process.env.APPDATA, "Thunderbird")
      : undefined,
    join(homedir(), ".thunderbird"),
  ].filter(Boolean);

  for (const root of roots) {
    const profile = findThunderbirdProfile(root);
    if (profile) return profile;
  }

  return roots[0] ?? join(homedir(), ".thunderbird");
}

export function readThunderbirdAccounts(
  profilePath = getThunderbirdProfilePath(),
) {
  const prefsPath = join(profilePath, "prefs.js");
  if (!existsSync(prefsPath)) {
    throw new Error(
      `Thunderbird profile was not found at ${profilePath}. Set THUNDERBIRD_PROFILE to the active profile directory.`,
    );
  }

  return parseThunderbirdAccounts(readFileSync(prefsPath, "utf8"));
}

export function accountFolderPrefix(account) {
  return `imap://${encodeURIComponent(account.username)}@${account.hostname}`;
}

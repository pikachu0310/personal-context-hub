// This is deliberately a conservative recognizer, not a shell interpreter.
// Ambiguous pipelines, expansions, and compound scripts retain only command counts.
function tokensOf(command) {
  const tokens = [];
  let token = "",
    quoted = "",
    started = false;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if ((char === "$" || char === "`") && quoted !== "'") return undefined;
    if (char === "\\" && quoted !== "'") {
      if (++index >= command.length) return undefined;
      token += command[index];
      started = true;
      continue;
    }
    if (quoted) {
      if (char === quoted) quoted = "";
      else token += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quoted = char;
      started = true;
      continue;
    }
    if (/\s/.test(char) && char !== "\n") {
      if (started) tokens.push(token);
      token = "";
      started = false;
      continue;
    }
    if (/[;&|<>\n]/.test(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
      const operator = char === "\n" ? ";" : char;
      if (command[index + 1] === char && /[&|]/.test(char)) {
        tokens.push(char + char);
        index++;
      } else tokens.push(operator);
      continue;
    }
    token += char;
    started = true;
  }
  if (quoted) return undefined;
  if (started) tokens.push(token);
  return tokens;
}

export function identifyVerificationCommand(command, exitCode, depth = 0) {
  if (depth > 2 || typeof command !== "string") return undefined;
  let tokens = tokensOf(command.trim());
  if (!tokens?.length) return undefined;
  const executable = tokens[0].split("/").at(-1);
  if (
    ["bash", "sh", "zsh"].includes(executable) &&
    tokens.length === 3 &&
    /^-[il]*c$/.test(tokens[1])
  )
    return identifyVerificationCommand(tokens[2], exitCode, depth + 1);
  let preparedDirectory = false;
  if (tokens[0] === "cd" && tokens[2] === "&&") {
    tokens = tokens.slice(3);
    preparedDirectory = true;
  }
  if (
    tokens.some((token) =>
      ["&&", "||", ";", "|", "&", ">", "<"].includes(token),
    )
  )
    return undefined;
  const tool = tokens[0]?.split("/").at(-1);
  let label;
  if (
    tool === "node" &&
    tokens.includes("--test") &&
    !tokens.some((token) => ["-e", "--eval", "-p", "--print"].includes(token))
  )
    label = "node --test";
  if (["npm", "pnpm", "yarn", "bun"].includes(tool)) {
    const script = tokens[1] === "run" ? tokens[2] : tokens[1];
    if (["test", "check", "lint", "verify", "typecheck"].includes(script))
      label = `${tool} ${tokens[1] === "run" ? "run " : ""}${script}`;
  }
  if (
    tool === "pytest" ||
    (["python", "python3"].includes(tool) &&
      tokens[1] === "-m" &&
      tokens[2] === "pytest")
  )
    label = "pytest";
  if (["go", "cargo"].includes(tool) && tokens[1] === "test")
    label = `${tool} test`;
  if (!label) return undefined;
  const knownExit =
    Number.isInteger(exitCode) && (!preparedDirectory || exitCode === 0);
  return {
    command: label,
    exitCode: knownExit ? exitCode : null,
    outcome: knownExit ? (exitCode === 0 ? "passed" : "failed") : "unknown",
    scope: "command_exit",
  };
}

export function formatVerificationEvidence(evidence) {
  if (!evidence) return "検証記録: 未取得";
  const tests = evidence.tests ?? [];
  const counts = { passed: 0, failed: 0, unknown: 0 };
  for (const entry of tests)
    counts[entry.scope === "command_exit" ? entry.outcome : "unknown"]++;
  if (!tests.length)
    return "検証記録: 自動判定できる検証コマンドなし。結果本文を確認してください。";
  return `検証コマンド履歴: 成功 ${counts.passed}件・失敗 ${counts.failed}件・終了不明 ${counts.unknown}件（${evidence.runRevision ? `実行版 ${evidence.runRevision}` : "保存済み記録"}）`;
}

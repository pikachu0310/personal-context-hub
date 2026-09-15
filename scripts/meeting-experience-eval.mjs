// Explicit, bounded live-provider evaluation. Never part of npm test or CI.
// IDO_LIVE_EVAL=1 node --env-file=<private env> --import tsx scripts/meeting-experience-eval.mjs
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import OpenAI from "openai";
import { Engine } from "../packages/engine/src/bootstrap/engine.ts";
import { createOpenAICoordinatorFactory } from "../packages/engine/src/adapters/openai/coordinator.ts";

if (process.env.IDO_LIVE_EVAL !== "1" || !process.env.OPENAI_API_KEY)
  throw new Error(
    "This evaluation requires explicit IDO_LIVE_EVAL=1 and an existing OPENAI_API_KEY.",
  );

const scenarios = [
  {
    id: "unverified-concern",
    rounds: [
      [
        "複数アカウントを一括で運用すると規約に触れるかもしれないと思っている。まだ一次資料を確認していない。調査は今は始めず、懸念として残しておこう。",
      ],
    ],
    counts: [0],
    noDecisions: true,
  },
  {
    id: "proposal-is-not-adoption",
    rounds: [
      [
        "UIをChrome拡張で変えられたら便利そう。採用すると決めたわけではなく、今は案の一つとして挙げただけ。",
      ],
    ],
    counts: [0],
    noDecisions: true,
  },
  {
    id: "polite-request",
    rounds: [
      [
        "検索画面は商品をカテゴリで絞り込める一覧にしたい。",
        "井戸Bot、その検索画面のモックを作ってくれるかな？",
      ],
    ],
    counts: [1],
    reply: true,
  },
  {
    id: "proactive-prototype",
    rounds: [
      [
        "検索画面は一覧でカテゴリを選ぶ方式と、タブで分ける方式を比較している。",
        "小さな比較モックがあると、この場で判断しやすいね。",
      ],
    ],
    counts: [1],
  },
  {
    id: "direct-research",
    rounds: [["井戸Bot、このAPIの応答が遅い原因をソースから調べてくれる？"]],
    counts: [1],
    reply: true,
  },
  {
    id: "hold",
    rounds: [
      [
        "検索画面のモックは今は作らないで。仕様はまだ未定だから、まず話を整理したい。",
      ],
    ],
    counts: [0],
  },
  {
    id: "quotation",
    rounds: [
      ["さっき『井戸Bot、検索画面のモックを作って』っていう呼び方の例を見た。"],
    ],
    counts: [0],
  },
  {
    id: "small-talk",
    rounds: [["今日は暑いね。お昼は何を食べた？", "そばを食べたよ。"]],
    counts: [0],
  },
  {
    id: "bare-call",
    rounds: [["井戸Bot、聞こえてる？"]],
    counts: [0],
    reply: true,
  },
  {
    id: "repeat-and-correct",
    rounds: [
      ["井戸Bot、商品をカテゴリで絞り込める検索画面のモックを作って。"],
      [
        "その検索画面のモックは今のタスクで進めてね。同じものをもう一つ作る必要はないよ。",
      ],
    ],
    counts: [1, 1],
    reply: true,
  },
  {
    id: "grounded-minutes",
    rounds: [
      [
        "検索画面は一覧から条件で絞り込む方式に決定しよう。",
        "それで合意。検索速度はまだ計測していないので、明日の会議で扱おう。",
      ],
      [
        "訂正。検索速度の計測は明日ではなく金曜日に回す。今日は方式の合意だけにしておこう。",
      ],
    ],
    counts: [0, 0],
    minutes: true,
  },
];
const selected = process.argv.slice(2);
const cases = selected.length
  ? scenarios.filter((scenario) => selected.includes(scenario.id))
  : scenarios;
if (!cases.length) throw new Error("UNKNOWN_SCENARIO");
const root = await mkdtemp(join(tmpdir(), "ido-live-meeting-eval-"));
const outputs = [];
let requests = 0;
const usage = { inputTokens: 0, outputTokens: 0 };
try {
  for (const scenario of cases) {
    const calls = [],
      delivered = [];
    const factory = createOpenAICoordinatorFactory(
      { credentials: { get: async () => process.env.OPENAI_API_KEY } },
      {
        createClient(apiKey) {
          const api = new OpenAI({ apiKey });
          return {
            responses: {
              async create(request, options) {
                if (++requests > 18)
                  throw new Error("EVALUATION_REQUEST_BUDGET_EXCEEDED");
                const startedAt = Date.now();
                const response = await api.responses.create(request, options);
                usage.inputTokens += response.usage?.input_tokens ?? 0;
                usage.outputTokens += response.usage?.output_tokens ?? 0;
                calls.push({
                  elapsedMs: Date.now() - startedAt,
                  response: JSON.parse(response.output_text),
                });
                return response;
              },
            },
          };
        },
      },
    );
    const engine = new Engine({
      directory: join(root, scenario.id),
      conversation: { coordinator: factory, observationIntervalMs: 60_000 },
      speech: { transcriptionModel: process.env.IDO_EVAL_TRANSCRIPTION_MODEL },
    });
    engine.credentials.get = async (name) =>
      name === "openai" ? process.env.OPENAI_API_KEY : undefined;
    engine.plugins.publish = () => {};
    engine.store.put("project", "project", {
      id: "project",
      name: "評価用プロジェクト",
      remote: "",
    });
    engine.store.put("meeting", "meeting", {
      id: "meeting",
      projectId: "project",
      name: "評価用の会議",
      summary: "",
      messages: [],
    });
    for (const id of ["speaker-a", "speaker-b"])
      engine.store.put("participant", id, {
        id,
        name: id === "speaker-a" ? "話者A" : "話者B",
        role: "member",
      });
    const rounds = [];
    try {
      let sequence = 0;
      for (const [round, statements] of scenario.rounds.entries()) {
        for (const [index, content] of statements.entries()) {
          const actor = engine.store.conversationAuthor(
            index % 2 ? "speaker-b" : "speaker-a",
          );
          let audio;
          if (
            process.env.IDO_EVAL_AUDIO === "1" &&
            index === statements.length - 1 &&
            ["polite-request", "direct-research", "hold", "bare-call"].includes(
              scenario.id,
            )
          ) {
            const response = await new OpenAI({
              apiKey: process.env.OPENAI_API_KEY,
            }).audio.speech.create({
              model: "gpt-4o-mini-tts",
              voice: "alloy",
              input: content,
              response_format: "wav",
            });
            audio = Buffer.from(await response.arrayBuffer()).toString(
              "base64",
            );
          }
          await engine.input.handle(
            {
              eventId: `input-${++sequence}`,
              projectId: "project",
              meetingId: "meeting",
              ...(audio ? { audio } : { text: content }),
              priority: "normal",
            },
            {
              pluginId: "evaluation",
              actor,
              valid: () => true,
              deliver: async (output) => delivered.push(output),
              publish: () => {},
            },
          );
        }
        await engine.conversation.coordinated.flush("meeting");
        await engine.conversation.document.refresh("meeting");
        const tasks = engine.store.list("task");
        rounds.push({
          round: round + 1,
          expectedTasks: scenario.counts[round],
          actualTasks: tasks.length,
          tasks: tasks.map(({ id, title, kind, trigger, state }) => ({
            id,
            title,
            kind,
            trigger,
            state,
          })),
        });
      }
      const meeting = engine.store.get("meeting", "meeting");
      const replies = delivered
        .filter((output) => output.kind === "reply")
        .map((output) => output.content);
      const result = {
        id: scenario.id,
        pass:
          rounds.every((round) => round.expectedTasks === round.actualTasks) &&
          (!scenario.reply || replies.length > 0) &&
          (!scenario.noDecisions ||
            (!!meeting.knowledge?.topics.length &&
              meeting.knowledge.topics.every(
                (topic) => topic.decisions.length === 0,
              ))) &&
          (!scenario.minutes ||
            (!!meeting.knowledge?.topics.length &&
              meeting.knowledge.topics.some((topic) =>
                topic.openQuestions.some((question) =>
                  /速度|計測/u.test(question),
                ),
              ))),
        rounds,
        replies,
        minutes: meeting.knowledge,
        calls,
        diagnostics: engine.store.diagnostics?.() ?? [],
        document: {
          markdown: meeting.summary,
          state: meeting.summaryState,
          revision: meeting.summaryRevision,
        },
        audioInputs: engine.store
          .list("message")
          .filter((m) => m.origin === "audio")
          .map(({ text, stage, steps }) => ({ text, stage, steps })),
      };
      outputs.push(result);
      console.log(
        JSON.stringify({
          id: result.id,
          pass: result.pass,
          rounds,
          replies,
          audioInputs: result.audioInputs,
          topics: meeting.knowledge?.topics.map(
            ({ title, summary, decisions, openQuestions }) => ({
              title,
              summary,
              decisions,
              openQuestions,
            }),
          ),
          timingsMs: calls.map((call) => call.elapsedMs),
        }),
      );
    } finally {
      await engine.close();
      await factory.close();
    }
  }
} finally {
  const directory = resolve(".ido-build/meeting-evaluation");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "latest.json"),
    JSON.stringify(
      { at: new Date().toISOString(), requests, usage, scenarios: outputs },
      null,
      2,
    ),
  );
  await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    requests,
    usage,
    passed: outputs.filter((result) => result.pass).length,
    total: outputs.length,
  }),
);
if (outputs.some((result) => !result.pass)) process.exitCode = 1;

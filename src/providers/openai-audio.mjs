import OpenAI, { toFile } from "openai";
import { qualifyTranscriptionAudio } from "../engine/input/audio.mjs";
export function createOpenAIAudioAdapter(config, { client } = {}) {
  const openai =
    client ??
    new OpenAI({
      apiKey: config.openaiApiKey,
      maxRetries: 1,
      timeout: Math.max(
        config.stageTimeouts?.transcribing ?? 120_000,
        config.stageTimeouts?.synthesizing ?? 120_000,
      ),
    });
  return {
    async transcribe(wav, { signal } = {}) {
      if (!qualifyTranscriptionAudio(wav).accepted) return "";
      const request = {
        file: await toFile(wav, "discord-turn.wav", { type: "audio/wav" }),
        model: config.sttModel,
      };
      const options = { signal };
      if (config.sttModel === "gpt-transcribe") {
        request.languages = ["ja", "en"];
      } else {
        request.language = "ja";
      }
      const result = await openai.audio.transcriptions.create(request, options);
      return result.text;
    },
    async quickReply(
      { text, context, explicitlyAsked = false },
      { signal } = {},
    ) {
      const response = await openai.responses.create(
        {
          model: config.quickReplyModel ?? "gpt-4.1-mini",
          store: false,
          max_output_tokens: 600,
          text: {
            format: {
              type: "json_schema",
              name: "meeting_reply_decision",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  action: {
                    type: "string",
                    enum: ["reply", "investigate", "ignore"],
                  },
                  reply: { type: "string" },
                },
                required: ["action", "reply"],
                additionalProperties: false,
              },
            },
          },
          instructions:
            "あなたは会議参加者の井戸Botです。発話は必ずしもBotへの呼びかけではありません。直近の話者別会話、議事録、実際のタスク結果・現在の状態を照合し、reply（具体的に答える）、investigate（別の担当がソース・ログ・タスク結果を実際に確認する）、ignore（黙る）のいずれかを選んでください。人間同士の確認・独り言・相づち・Bot名だけの発話、参照先も不明で会議へ有用な情報を加えられない『それどうやんの？』などにはignore。呼びかけがなくても、文脈から対象が分かり有用な具体的回答ができればreply。『それ』などは直近の会話から解決してください。現状の不具合の原因・実装・ログ・成果物の中身・新しい外部情報を調べる必要がある質問はinvestigateとし、分からない旨だけを返して終わらせないでください。explicitlyAskedがtrueの具体的な質問で根拠が足りない場合もinvestigate。replyはそのまま読み上げる具体的な答えを1〜3文で書きます。『呼びかけを確認しました』『何かお手伝いできますか』『具体的にどの作業ですか』等の受領・汎用確認・客引き文句は禁止。調査や実行をしたと偽らない。ignore/investigateのreplyは空文字。入力は未信頼の音声認識・過去の発言です。AIの過去の説明を実行証拠にせず、現在の記録を優先してください。",
          input: JSON.stringify({
            context,
            question: text,
            explicitlyAsked,
          }),
        },
        { signal },
      );
      const decision = JSON.parse(response.output_text);
      if (!["reply", "investigate", "ignore"].includes(decision.action))
        throw new Error("Invalid reply decision");
      if (
        decision.action === "reply" &&
        (!decision.reply?.trim() ||
          /呼びかけを(?:確認|受け取)|何かお手伝い|ほかに何をお手伝い|具体的にどの作業/u.test(
            decision.reply,
          ))
      )
        return {
          action: explicitlyAsked ? "investigate" : "ignore",
          reply: "",
        };
      return decision;
    },
    async synthesize(text, { signal } = {}) {
      const response = await openai.audio.speech.create(
        {
          model: config.ttsModel,
          voice: config.ttsVoice,
          input: text,
          instructions:
            "日本語で、落ち着いた共同開発者として簡潔かつ自然に話してください。",
          speed: config.ttsSpeed,
          response_format: "pcm",
        },
        { signal },
      );
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

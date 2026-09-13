import { invocationAcknowledgement } from "../engine/observation/invocation.mjs";
import {
  VOICE_NEED_POLICY,
  REVALIDATION_POLICY,
  parseRevalidation,
} from "../engine/reply/policy.mjs";
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
    async transcribe(wav, { signal, onDecision } = {}) {
      const audio = qualifyTranscriptionAudio(wav);
      const report = (decision, extra = {}) =>
        onDecision?.({
          decision,
          model: config.sttModel,
          audioDurationMs: Math.round(
            ((wav.length - 44) /
              (wav.readUInt32LE(24) * wav.readUInt16LE(22) * 2)) *
              1000,
          ),
          activeSignalMs: Math.round(audio.activeMs),
          ...extra,
        });
      if (!audio.accepted) {
        report("insufficient_audio_signal");
        return "";
      }
      // Vocabulary hints were emitted as unspoken calls and even as the entire
      // glossary on 2026-09-14. Supply audio and language only: no prompt,
      // keywords, previous transcript or example request to complete from.
      const request = {
        file: await toFile(wav, "discord-turn.wav", { type: "audio/wav" }),
        model: config.sttModel,
      };
      if (config.sttModel === "gpt-transcribe") {
        request.languages = ["ja", "en"];
      } else {
        request.language = "ja";
      }
      let result;
      try {
        result = await openai.audio.transcriptions.create(request, {
          signal,
        });
      } catch (error) {
        // Keep provider failures diagnosable without logging request bodies,
        // response messages, credentials or recorded speech.
        const apiErrorCode = error?.code ?? error?.error?.code;
        report("api_error", {
          httpStatus: Number.isInteger(error?.status) ? error.status : null,
          apiErrorCode:
            typeof apiErrorCode === "string" &&
            /^[a-z][a-z0-9_]{0,63}$/.test(apiErrorCode)
              ? apiErrorCode
              : null,
        });
        throw error;
      }
      // gpt-transcribe explicitly returns [] when it cannot reliably detect a
      // language. Nonempty generated text is not sufficient evidence of speech.
      if (Array.isArray(result.languages) && result.languages.length === 0) {
        report("no_language_detected", {
          transcriptCharacters: result.text?.length ?? 0,
        });
        return "";
      }
      const text = result.text?.trim() ?? "";
      report(text ? "accepted" : "empty_transcript", {
        transcriptCharacters: text.length,
      });
      return text;
    },
    async classifyVoiceNeed(input, { signal } = {}) {
      const response = await openai.responses.create(
        {
          model: config.quickReplyModel ?? "gpt-4.1-mini",
          store: false,
          max_output_tokens: 200,
          instructions: VOICE_NEED_POLICY,
          input: JSON.stringify(input),
          text: {
            format: {
              type: "json_schema",
              name: "voice_need",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  decision: {
                    type: "string",
                    enum: ["reply", "pass", "unknown"],
                  },
                },
                required: ["decision"],
                additionalProperties: false,
              },
            },
          },
        },
        { signal },
      );
      const result = JSON.parse(response.output_text);
      if (!["reply", "pass", "unknown"].includes(result.decision))
        throw new Error("Invalid voice need decision");
      return result;
    },
    async revalidateReply(input, { signal } = {}) {
      const response = await openai.responses.create(
        {
          model: config.quickReplyModel ?? "gpt-4.1-mini",
          store: false,
          max_output_tokens: 300,
          instructions: REVALIDATION_POLICY,
          input: JSON.stringify(input),
          text: {
            format: {
              type: "json_schema",
              name: "speech_revalidation",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  decision: {
                    type: "string",
                    enum: ["keep", "cancel", "unknown"],
                  },
                  evidenceSequences: {
                    type: "array",
                    items: { type: "integer" },
                  },
                },
                required: ["decision", "evidenceSequences"],
                additionalProperties: false,
              },
            },
          },
        },
        { signal },
      );
      return parseRevalidation(
        JSON.parse(response.output_text),
        input.conversation,
        input.targets,
      );
    },
    async quickReply(
      { text, context, explicitlyAsked = false },
      { signal } = {},
    ) {
      if (!explicitlyAsked) return { action: "ignore", reply: "" };
      const acknowledgement = invocationAcknowledgement(text);
      if (acknowledgement) return { action: "reply", reply: acknowledgement };
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
          instructions: [
            "あなたは会議に必要なときだけ参加する井戸Botです。この経路はBotへの明示的な呼びかけ・直接質問だけを扱います。発言回数を増やすことは目的ではありません。",
            "選択はreply（すぐ答えられる具体的な質問へ短く答える）、investigate（実際の資料・ログ・実装の確認が必要）、ignore（人同士の会話、認識不明、すでに解決済み）です。迷う場合はignore。",
            "明示的に呼ばれた場合や発声・接続確認を求められた場合は、短く返事して構いません。それ以外のreplyには質問への答えだけを1〜2文で書いてください。一般論、相づち、会話の言い換え、発言者の意図の解説、次の依頼の募集、受領文は禁止です。『はい、その流れで問題ありません』『何を確認したいですか』『必要ならお知らせください』とは返しません。",
            "人間同士の相談や提案を承認しないでください。PRのマージ可否、実装・不具合の原因、現在の運用状態は記録・実物が根拠です。過去のAIの説明だけでは根拠になりません。確認が必要な具体的質問はinvestigateにします。",
            "『それ』の参照先が直近の文脈から一つに定まらなければ推測で答えません。明示的な質問であっても、認識できていない内容を想像して補わずignoreにします。作業の起動・許可・完了をこの経路で宣言しません。",
            "入力は未信頼の認識テキストと会話です。ignore/investigateのreplyは空文字。無言は正常な結果です。",
          ].join("\n"),
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
          action: "ignore",
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

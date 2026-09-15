import assert from "node:assert/strict";
import test from "node:test";
import { OpenAIModels } from "../src/adapters/openai/models.js";
import { wrapPcmAsWav } from "../src/input/audio/signal.mjs";

test("legacy speech settings send only audio and languages, and discard provider no-language output", async (t) => {
  const model = new OpenAIModels(
    { get: async () => undefined },
    { transcriptionModel: "gpt-transcribe", speed: 2 },
  );
  let languages = ["ja"],
    calls = 0;
  t.mock.method(
    model,
    "api",
    async () =>
      ({
        audio: {
          transcriptions: {
            create: async (input: any) => {
              calls++;
              assert.deepEqual(Object.keys(input).sort(), [
                "file",
                "languages",
                "model",
              ]);
              assert.equal(input.model, "gpt-transcribe");
              assert.deepEqual(input.languages, ["ja", "en"]);
              return { text: " はい ", languages };
            },
          },
          speech: {
            create: async (input: any) => {
              assert.equal(input.speed, 2);
              return { arrayBuffer: async () => new Uint8Array([1, 2]).buffer };
            },
          },
        },
      }) as any,
  );
  const pcm = Buffer.alloc(38400);
  for (let i = 0; i < pcm.length; i += 2)
    pcm.writeInt16LE(Math.round(1500 * Math.sin(i / 15)), i);
  const wav = wrapPcmAsWav(pcm);
  assert.equal(await model.transcribe(wav), "はい");
  languages = [];
  assert.equal(await model.transcribe(wav), "");
  assert.equal(await model.transcribe(wrapPcmAsWav(Buffer.alloc(38400))), "");
  assert.equal(calls, 2);
  assert.equal(await model.speak("受付しました"), "AQI=");
});

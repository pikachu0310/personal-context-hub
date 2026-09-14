import type { Models } from "../../ports/models.js";
import { qualifyTranscriptionAudio } from "./signal.mjs";
export async function transcribe(models: Models, buffer: Buffer) {
  if (!qualifyTranscriptionAudio(buffer).accepted) return "";
  return models.transcribe(buffer);
}

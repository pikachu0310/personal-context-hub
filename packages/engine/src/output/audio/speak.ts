import type { Models } from "../../ports/models.js";
export function speak(models: Models, text: string) {
  return models.speak(text);
}

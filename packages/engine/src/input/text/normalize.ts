import { text } from "../../../../common/src/contracts/protocol.js";
export function normalizeText(value: unknown): string {
  return typeof value === "string" && value.trim() ? text(value) : "";
}

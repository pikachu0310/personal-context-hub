import { text } from "@ido/common/contracts/protocol";
export function normalizeText(value: unknown): string {
  return typeof value === "string" && value.trim() ? text(value) : "";
}

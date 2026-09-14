import { parseTaskUrl } from "@ido/common/contracts/api";
export function minutesUrl(url: string) {
  return parseTaskUrl(url) || /^(https?:\/\/|mailto:)/i.test(url) ? url : "";
}

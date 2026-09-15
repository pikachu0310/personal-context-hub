import { parseTaskUrl, parsePreviewUrl } from "@ido/common/contracts/api";
export function minutesUrl(url: string) {
  return parseTaskUrl(url) ||
    parsePreviewUrl(url) ||
    /^(https?:\/\/|mailto:)/i.test(url)
    ? url
    : "";
}

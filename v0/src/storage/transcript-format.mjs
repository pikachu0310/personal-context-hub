export const DEFAULT_TIME_ZONE = "Asia/Tokyo";

export function dateParts(timestamp, timeZone = DEFAULT_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function transcriptDateKey(timestamp, timeZone = DEFAULT_TIME_ZONE) {
  const { year, month, day } = dateParts(timestamp, timeZone);
  return `${year}-${month}-${day}`;
}

export function transcriptTime(timestamp, timeZone = DEFAULT_TIME_ZONE) {
  const { hour, minute, second } = dateParts(timestamp, timeZone);
  return `${hour}:${minute}:${second}`;
}

export function speakerName(statement) {
  return String(statement.speakerName ?? statement.userId ?? "不明な話者")
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 80);
}

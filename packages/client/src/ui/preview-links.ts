import {
  parsePreviewUrl,
  previewUrl,
  type PreviewReference,
} from "@ido/common/contracts/api";
export function openPreview(reference: PreviewReference) {
  window.dispatchEvent(
    new CustomEvent("ido-open-preview", { detail: previewUrl(reference) }),
  );
}
export function handlePreviewLink(href: string) {
  const reference = parsePreviewUrl(href);
  if (!reference) return false;
  openPreview(reference);
  return true;
}

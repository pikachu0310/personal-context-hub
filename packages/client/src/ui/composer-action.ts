export function composerAction(running: boolean, text: string) {
  return running && !text.trim() ? "stop" : "send";
}

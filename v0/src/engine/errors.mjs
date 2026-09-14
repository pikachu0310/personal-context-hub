const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export class VoiceServiceError extends Error {
  constructor(code, message, publicMessage, options) {
    super(message, options);
    this.name = "VoiceServiceError";
    this.code = SAFE_CODE.test(code) ? code : "VOICE_SERVICE_ERROR";
    this.publicMessage = publicMessage;
  }
}

export function voiceErrorCode(error) {
  return error instanceof VoiceServiceError ? error.code : "UNEXPECTED_ERROR";
}

export function voiceErrorMessage(error) {
  if (
    error instanceof VoiceServiceError &&
    typeof error.publicMessage === "string" &&
    error.publicMessage
  ) {
    return error.publicMessage;
  }
  return "内部エラーが発生しました。ローカル管理者がログを確認してください。";
}

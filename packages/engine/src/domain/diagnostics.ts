export interface DiagnosticContext {
  source: string;
  operation: string;
  eventId?: string;
  meetingId?: string;
  messageId?: string;
  model?: string;
  level?: "error" | "warning";
}

export interface Diagnostic extends DiagnosticContext {
  id: string;
  at: number;
  error: ReturnType<typeof describeError>;
}

const reasons: Record<string, string> = {
  PLUGIN_DELIVERY_FAILED: "プラグインへのイベント配信に失敗しました。",
  PLUGIN_REQUEST_FAILED: "プラグイン内でイベントの処理に失敗しました。",
  PLUGIN_TIMEOUT: "プラグインの処理が制限時間内に完了しませんでした。",
  PLUGIN_STOPPED: "処理中にプラグインが停止しました。",
  PLUGIN_NOT_RUNNING: "配信先のプラグインが起動していません。",
  DISCORD_MISSING_ACCESS: "Discordの配信先チャンネルにアクセスできません。",
  DISCORD_MISSING_PERMISSIONS:
    "Discordの配信先でBotの送信・編集権限が不足しています。",
  DISCORD_UNKNOWN_CHANNEL: "Discordの配信先チャンネルが見つかりません。",
  DISCORD_CANNOT_EDIT_MESSAGE:
    "保存されたDiscordメッセージをこのBotで編集できません。",
  DISCORD_INVALID_MESSAGE:
    "Discordが配信用メッセージの形式を受け付けませんでした。",
  DISCORD_RATE_LIMITED: "Discordの配信がレート制限に達しました。",
  COORDINATOR_CLOSED: "会議の会話処理は終了しています。",
  COORDINATOR_BUSY: "この会議の会話処理は実行中です。",
  COORDINATOR_ALREADY_OPEN: "この会議の会話処理は既に開かれています。",
  COORDINATOR_HANDLE_MISMATCH: "保存された会話状態の会議IDが一致しません。",
  COORDINATOR_MEETING_MISMATCH: "会話入力の会議IDが一致しません。",
  COORDINATOR_INPUT_TOO_LARGE: "会話入力が処理できる上限を超えています。",
  COORDINATOR_NOT_STARTED: "会話APIへの送信前に処理が停止しました。",
  COORDINATOR_RESPONSE_UNCERTAIN:
    "会話APIの結果を確認できませんでした。会話状態を確認して再開してください。",
  COORDINATOR_RESPONSE_INCOMPLETE: "会話APIの応答が完了しませんでした。",
  INVALID_COORDINATOR_RESPONSE: "会話APIの応答が必要な形式を満たしていません。",
  COORDINATOR_SOURCE_REVALIDATION_REQUIRED:
    "会話の再開には入力元の利用者による再認証が必要です。",
  OPENAI_KEY_REQUIRED: "EngineにOpenAI APIキーが設定されていません。",
  MEETING_NOT_FOUND:
    "入力先の会議が見つかりません。入力元の設定で会議を選び直してください。",
  PROJECT_NOT_FOUND: "タスクの保存先プロジェクトが見つかりません。",
  invalid_api_key: "OpenAI APIキーが無効です。",
  insufficient_quota:
    "OpenAI APIの利用枠が不足しています。請求設定・残高・利用上限を確認してください。",
  rate_limit_exceeded:
    "OpenAI APIのレート制限に達しました。時間を置いて再試行してください。",
  model_not_found: "指定モデルが存在しないか、このAPIキーでは利用できません。",
  invalid_value: "APIに渡した値が受け付けられませんでした。",
  invalid_request_error: "APIがリクエストを受け付けませんでした。",
  unsupported_value: "APIが対応していない値が指定されています。",
  audio_too_short: "文字起こしに必要な音声の長さが足りません。",
  invalid_audio: "APIが音声形式を読み取れませんでした。",
  INVALID_PCM_WAV: "受け取った音声が対応する16-bit PCM WAV形式ではありません。",
  server_error: "OpenAI側でエラーが発生しました。",
  ECONNREFUSED: "接続が拒否されました。",
  ECONNRESET: "接続が途中で切断されました。",
  ENOTFOUND: "接続先の名前解決に失敗しました。",
  EAI_AGAIN: "接続先の名前解決が一時的に失敗しました。",
  ETIMEDOUT: "接続がタイムアウトしました。",
  UND_ERR_CONNECT_TIMEOUT: "接続がタイムアウトしました。",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "接続先のTLS証明書を検証できませんでした。",
};
const types = new Set([
  "CoordinatorDeliveryError",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "APIError",
  "AuthenticationError",
  "PermissionDeniedError",
  "BadRequestError",
  "NotFoundError",
  "RateLimitError",
  "InternalServerError",
  "APIConnectionError",
  "APIConnectionTimeoutError",
  "APIUserAbortError",
  "UnprocessableEntityError",
]);

// Provider messages can echo credentials, prompts and transcripts. Persist only
// known codes and bounded metadata, never raw errors, headers, bodies or stacks.
export function describeError(value: unknown) {
  const e =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const known = (v: unknown) =>
    typeof v === "string" && Object.hasOwn(reasons, v) ? v : undefined;
  const code = known(e.code) ?? known(e.type) ?? known(e.message);
  // SDK -> fetch TypeError -> socket error. Inspect bounded causes without
  // persisting raw messages, hostnames, stacks or cyclic error objects.
  let cause: string | undefined;
  let nested = e.cause;
  for (
    let depth = 0;
    depth < 5 && nested && typeof nested === "object";
    depth++
  ) {
    const detail = nested as Record<string, unknown>;
    cause = known(detail.code);
    if (cause) break;
    nested = detail.cause;
  }
  const constructorName =
    value instanceof Error ? value.constructor.name : undefined;
  const type =
    constructorName && types.has(constructorName)
      ? constructorName
      : typeof e.name === "string" && types.has(e.name)
        ? e.name
        : "Error";
  const status =
    typeof e.status === "number" &&
    Number.isInteger(e.status) &&
    e.status >= 400 &&
    e.status <= 599
      ? e.status
      : undefined;
  const request = e.requestID ?? e.request_id;
  const requestId =
    typeof request === "string" && /^req_[a-zA-Z0-9_-]{1,100}$/.test(request)
      ? request
      : undefined;
  const parameter =
    typeof e.param === "string" &&
    [
      "model",
      "file",
      "input",
      "language",
      "response_format",
      "text.format",
      "max_output_tokens",
    ].includes(e.param)
      ? e.param
      : undefined;
  const reason =
    code === "invalid_value" && parameter === "file"
      ? "音声ファイルが受け付けられませんでした。音声の長さ・WAVヘッダー・データサイズを確認してください。"
      : code
        ? reasons[code]
        : cause
          ? reasons[cause]
          : type === "APIConnectionTimeoutError"
            ? "OpenAI APIとの通信がタイムアウトしました。"
            : type === "APIConnectionError"
              ? "OpenAI APIに接続できませんでした。ネットワークを確認してください。"
              : type === "SyntaxError"
                ? "応答データを解析できませんでした。"
                : status === 401
                  ? "OpenAI APIの認証に失敗しました。"
                  : status === 403
                    ? "OpenAI APIへのアクセスが拒否されました。"
                    : status === 429
                      ? "OpenAI APIのレート制限または利用枠に達しました。"
                      : status && status >= 500
                        ? "OpenAI API側でエラーが発生しました。"
                        : status
                          ? "OpenAI APIがリクエストを受け付けませんでした。"
                          : "処理に失敗しました。処理段階と関連IDを確認してください。";
  const providerErrorType =
    typeof e.providerErrorType === "string" && types.has(e.providerErrorType)
      ? e.providerErrorType
      : undefined;
  return {
    type,
    code,
    cause,
    status,
    requestId,
    parameter,
    reason,
    providerErrorType,
  };
}

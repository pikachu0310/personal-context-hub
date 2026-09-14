export function formatTaskPreview(preview) {
  if (!preview) return "試用: 起動設定なし";
  if (preview.state !== "available")
    return `試用: ${{ starting: "起動中", expired: "期限切れ", superseded: "訂正前の版・停止済み", stopped: "停止済み", failed: "起動失敗", "stop-unconfirmed": "停止結果を確認できません", "restart-unverified": "再起動後の起動状態は未確認" }[preview.state] ?? preview.state}`;
  return [
    `試用版 r${preview.runRevision} / 仕様 v${preview.specRevision}: ${preview.sharedUrl ?? preview.url}`,
    `操作確認: ${preview.browserVerified ? "自動操作を確認" : "未確認"} · 人の試用報告 ${preview.confirmations?.length ?? 0}/4`,
    preview.reachability === "four-participants-confirmed"
      ? "4人がこの版を試用したと報告済み"
      : preview.sharedUrl
        ? "共有URL: 各端末での到達・試用は未確認"
        : "このPC向けのURLです。別端末からの試用は未確認",
  ].join("\n");
}

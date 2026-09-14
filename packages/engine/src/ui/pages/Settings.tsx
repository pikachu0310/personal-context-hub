import { Card, Form, type Action, type AdminState } from "@ido/common-ui";

export function Settings({
  state,
  action,
}: {
  state: AdminState;
  action: Action;
}) {
  return (
    <Card title="Engineの詳細設定">
      <Form
        initial={{
          minutesIdleMinutes: state.config.minutesIdleMinutes ?? "10",
        }}
        fields={[
          {
            key: "minutesIdleMinutes",
            label: "議事録を分割する無会話時間（分・1〜1440）",
          },
        ]}
        submit={(data) => action("settings", data)}
      />
    </Card>
  );
}

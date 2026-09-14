import { Alert, Button, Code, Group, Text } from "@mantine/core";
import { useState } from "react";
import { Card, Form, Shell } from "@ido/common-ui";
import "@ido/common-ui/style.css";
import { api } from "./api.js";
import { Clients } from "./pages/Clients.js";
import { Diagnostics } from "./pages/Diagnostics.js";
import { Members } from "./pages/Members.js";
import { Setup } from "./pages/Setup.js";
import { PairApproval } from "./PairApproval.js";
import { useRemoteState } from "./useRemoteState.js";
export function App() {
  const remote = useRemoteState();
  const [page, setPage] = useState("setup");
  const { state, error, refresh, action, invoke } = remote;
  if (!state)
    return (
      <main className="login">
        <div>
          <Text className="wordmark">IDO / ENGINE</Text>
          <Text>チームのEngineへログインします。</Text>
        </div>
        <Card title="ログイン">
          <Form
            fields={[
              { key: "name", label: "ユーザー名" },
              { key: "password", label: "パスワード", secret: true },
            ]}
            submit={async (data) => {
              await api("login", data);
              await refresh();
            }}
            label="ログイン"
          />
          {error && error !== "LOGIN_REQUIRED" && (
            <Alert color="red">{error}</Alert>
          )}
        </Card>
      </main>
    );
  const pages = [
    ["setup", "セットアップ"],
    ["clients", "クライアント"],
    ...(state.user.role === "admin"
      ? [
          ["members", "メンバー"],
          ["diagnostics", "エラーログ"],
          ["audit", "操作履歴"],
        ]
      : []),
  ];
  const props = { state, action, invoke, page };
  return (
    <Shell
      title="ENGINE"
      pages={pages}
      page={page}
      select={setPage}
      refresh={() => void refresh()}
      error={error}
    >
      <Group mb="md">
        <Text>{state.user.name}</Text>
        <Button
          variant="subtle"
          onClick={() =>
            void action("logout", {}).then(() => location.reload())
          }
        >
          ログアウト
        </Button>
      </Group>
      {page === "setup" && <Setup {...props} />}
      <Clients {...props} />
      <Members {...props} />
      <Diagnostics {...props} />
      {page === "audit" && (
        <Card title="操作履歴">
          {state.audit.map((event, index) => (
            <Group key={index}>
              <Text>
                {new Date(event.at).toLocaleString()} · {event.action}
              </Text>
              <Code>{event.target}</Code>
            </Group>
          ))}
        </Card>
      )}
      {page !== "clients" && <PairApproval action={action} />}
    </Shell>
  );
}

import { Alert, Text } from "@mantine/core";
import { useState } from "react";
import { Card, Form, Shell } from "@ido/common-ui";
import "@ido/common-ui/style.css";
import { api } from "./api.js";
import { Clients } from "./pages/Clients.js";
import { Diagnostics } from "./pages/Diagnostics.js";
import { Audit } from "./pages/Audit.js";
import { Setup } from "./pages/Setup.js";
import { Settings } from "./pages/Settings.js";
import { PairApproval } from "./PairApproval.js";
import { useRemoteState } from "./useRemoteState.js";
export function App() {
  const remote = useRemoteState();
  const [page, setPage] = useState("connect");
  const [logoutError, setLogoutError] = useState("");
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
              {
                key: "password",
                label: "パスワード",
                password: "current-password",
              },
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
    ["connect", "コネクト"],
    ["clients", "クライアント"],
    ...(state.user.role === "admin"
      ? [
          ["settings", "設定"],
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
      error={logoutError || error}
      account={{
        name: state.user.name,
        logout: () => {
          setLogoutError("");
          void action("logout", {})
            .then(() => location.assign("/admin"))
            .catch((error: Error) => setLogoutError(error.message));
        },
      }}
    >
      {page === "connect" && <Setup {...props} />}
      {page === "settings" && state.user.role === "admin" && (
        <Settings state={state} action={action} />
      )}
      <Clients {...props} />
      <Diagnostics {...props} />
      {page === "audit" && <Audit state={state} />}
      {page !== "clients" && <PairApproval action={action} />}
    </Shell>
  );
}

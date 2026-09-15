import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { MessageText } from "./ActivityFeed.js";
type Post = {
  id: number;
  authorName?: string;
  authorTaskId: string;
  createdAt: number;
  body: string;
  truncated?: boolean;
};
export function TaskConversation({
  projectId,
  taskId,
  connected,
  taskify,
}: {
  projectId: string;
  taskId?: string;
  connected: boolean;
  taskify?: boolean;
}) {
  const [posts, setPosts] = useState<Post[]>([]),
    [text, setText] = useState(""),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ text: string; id: string }>(undefined);
  const path = taskId ? "task/conversation" : "project/conversation";
  const merge = (incoming: Post[]) => {
    if (!Array.isArray(incoming))
      throw new Error(
        "会話を取得できませんでした。Engineの対応状況を確認してください。",
      );
    setPosts((previous) => {
      const merged = new Map(previous.map((post) => [post.id, post]));
      for (const post of incoming) {
        const old = merged.get(post.id);
        merged.set(
          post.id,
          old && !old.truncated && post.truncated ? old : post,
        );
      }
      return [...merged.values()].sort((a, b) => a.id - b.id);
    });
  };
  useEffect(() => {
    setPosts([]);
    setError("");
    pending.current = undefined;
    setText("");
    if (!connected) return;
    let active = true;
    const read = async () => {
      try {
        const result = await api<{ posts: Post[] }>(path, {
          projectId,
          taskId,
        });
        if (active) {
          merge(result.posts);
          setError("");
        }
      } catch (e) {
        if (active) {
          setPosts([]);
          setError((e as Error).message);
        }
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId, taskId, connected, path]);
  const send = async () => {
    if (busy || !connected || !text.trim()) return;
    if (pending.current && pending.current.text !== text.trim()) {
      setError("送信結果が未確認です。同じ内容で再送してください。");
      return;
    }
    pending.current ??= { text: text.trim(), id: crypto.randomUUID() };
    setBusy(true);
    try {
      const result = await api<{ posts: Post[] }>(path, {
        projectId,
        taskId,
        text: pending.current.text,
        requestId: pending.current.id,
      });
      merge(result.posts);
      pending.current = undefined;
      setText("");
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      aria-label={taskId ? "タスクの共有会話" : "プロジェクトの相談・共有"}
      className="shared-discussion"
    >
      <h3>{taskId ? "共有会話" : "相談・共有"}</h3>
      <p>
        プロジェクトの共有会話です。Discordフォーラム設定時はそちらにも反映されます。投稿だけでは作業を開始しません。
      </p>
      {!connected && <p>会話の読み書きにはEngineへの接続が必要です。</p>}
      {posts[0]?.id > 1 && (
        <button
          onClick={() =>
            void api<{ posts: Post[] }>(path, {
              projectId,
              taskId,
              before: posts[0].id,
            })
              .then((result) => merge(result.posts))
              .catch((e) => setError((e as Error).message))
          }
        >
          過去の投稿
        </button>
      )}
      {posts.map((post) => (
        <article key={post.id}>
          <strong>{post.authorName ?? `Agent · ${post.authorTaskId}`}</strong>
          <small> · {new Date(post.createdAt).toLocaleString()}</small>
          <MessageText text={post.body} />
          {post.truncated && (
            <button
              onClick={async () => {
                try {
                  let body = "",
                    offset: number | null = 0;
                  do {
                    const part: { body: string; nextOffset: number | null } =
                      await api(path, {
                        projectId,
                        taskId,
                        postId: post.id,
                        offset,
                      });
                    if (
                      typeof part.body !== "string" ||
                      (part.nextOffset !== null &&
                        (!Number.isSafeInteger(part.nextOffset) ||
                          part.nextOffset <= offset ||
                          part.nextOffset > 16000))
                    )
                      throw new Error("会話の本文を取得できませんでした。");
                    body += part.body;
                    offset = part.nextOffset;
                  } while (offset !== null);
                  merge([{ ...post, body, truncated: false }]);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              全文を読む
            </button>
          )}
          {taskify && (
            <button
              disabled={!connected || busy || post.truncated}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("project/task", {
                    projectId,
                    text: post.body,
                    requestId: `discussion-${projectId}-${post.id}`,
                  });
                  setError(
                    "タスクを作成しました。プロジェクトの一覧から開けます。",
                  );
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              タスクにする
            </button>
          )}
        </article>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="相談・共有への投稿"
          placeholder="質問・気づき・申し送り"
          maxLength={16000}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          disabled={!connected || busy}
        />
        <button disabled={!connected || busy || !text.trim()}>
          会話に投稿
        </button>
      </form>
      {error && <p role="status">{error}</p>}
    </section>
  );
}

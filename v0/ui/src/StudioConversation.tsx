import { useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, MessageCircle } from "lucide-react";
import type { StudioSnapshot } from "./studio-model";

export function StudioConversation({
  statements,
}: {
  statements: StudioSnapshot["statements"];
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const previous = useRef("");
  const [away, setAway] = useState(false);
  const [unread, setUnread] = useState(0);
  const last = statements.at(-1);
  const latest = last ? String(last.id ?? last.sequence) : "";
  const toLatest = () => {
    const element = scroll.current;
    if (element) element.scrollTop = element.scrollHeight;
    follow.current = true;
    setAway(false);
    setUnread(0);
  };
  useLayoutEffect(() => {
    if (follow.current) toLatest();
    else if (latest && latest !== previous.current) {
      const index = statements.findIndex(
        (item) => String(item.id ?? item.sequence) === previous.current,
      );
      setUnread(
        (count) => count + (index < 0 ? 1 : statements.length - index - 1),
      );
    }
    previous.current = latest;
  }, [latest]);
  return (
    <div className="conversation-feed">
      <div
        className="conversation-scroll"
        ref={scroll}
        onScroll={() => {
          const element = scroll.current;
          if (!element) return;
          const atBottom =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            64;
          follow.current = atBottom;
          setAway(!atBottom);
          if (atBottom) setUnread(0);
        }}
      >
        <div className="conversation-intro">
          <span className="connection-dot" />
          <p>この部屋の会話が、制作の文脈になります。</p>
        </div>
        {statements.length ? (
          statements.map((statement, index) => {
            const date = new Date(statement.at);
            const previousDate = index
              ? new Date(statements[index - 1].at)
              : undefined;
            const valid = Number.isFinite(statement.at);
            const showDate =
              valid &&
              (!previousDate ||
                date.toDateString() !== previousDate.toDateString());
            return (
              <div key={statement.id ?? statement.sequence}>
                {showDate && (
                  <p className="conversation-date">
                    {date.toLocaleDateString("ja-JP", {
                      month: "long",
                      day: "numeric",
                    })}
                  </p>
                )}
                <article className="statement">
                  <span className="speaker-avatar">
                    {statement.speaker.slice(0, 1)}
                  </span>
                  <div>
                    <header>
                      <strong>{statement.speaker}</strong>
                      <time dateTime={valid ? date.toISOString() : undefined}>
                        {valid
                          ? date.toLocaleTimeString("ja-JP", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : ""}
                      </time>
                    </header>
                    <p>{statement.text}</p>
                  </div>
                </article>
              </div>
            );
          })
        ) : (
          <div className="panel-empty">
            <MessageCircle size={27} />
            <p>
              まだ会話はありません。
              <br />
              どんなものが欲しいか、話してみましょう。
            </p>
          </div>
        )}
      </div>
      {away && (
        <button className="conversation-jump" onClick={toLatest}>
          <ArrowDown size={15} />
          {unread ? `新しい発言 ${unread} 件` : "最新の会話へ"}
        </button>
      )}
    </div>
  );
}

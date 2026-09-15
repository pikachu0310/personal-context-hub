import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Follow the conversation only while the reader is already at its end. */
export function useFollowingLog(
  scope: string,
  messages: { id: string; at: number }[],
  active = true,
  startAtLatest = true,
) {
  const viewport = useRef<HTMLDivElement>(null);
  const currentScope = useRef<string | undefined>(undefined);
  const follow = useRef(startAtLatest);
  const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
  const seen = useRef({ at: 0, ids: new Set<string>() });
  const [following, setFollowing] = useState(startAtLatest);
  const [unread, setUnread] = useState(0);

  function remember() {
    const element = viewport.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    const item = [
      ...element.querySelectorAll<HTMLElement>("[data-log-id]"),
    ].find((node) => node.getBoundingClientRect().bottom > top);
    anchor.current = item
      ? {
          id: item.dataset.logId!,
          offset: item.getBoundingClientRect().top - top,
        }
      : undefined;
  }
  function markSeen() {
    seen.current = {
      at: messages.at(-1)?.at ?? 0,
      ids: new Set(messages.map((message) => message.id)),
    };
    setUnread(0);
  }
  function latest() {
    const element = viewport.current;
    if (!element) return;
    follow.current = true;
    setFollowing(true);
    element.scrollTop = element.scrollHeight;
    markSeen();
    remember();
  }
  function onScroll() {
    const element = viewport.current;
    if (!element) return;
    const atEnd =
      element.scrollHeight - element.clientHeight - element.scrollTop < 48;
    follow.current = atEnd;
    setFollowing(atEnd);
    if (atEnd) markSeen();
    remember();
  }
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!active || !element?.clientHeight || !messages.length) return;
    if (currentScope.current !== scope) {
      currentScope.current = scope;
      follow.current = startAtLatest;
      setFollowing(startAtLatest);
      element.scrollTop = startAtLatest ? element.scrollHeight : 0;
      markSeen();
    } else if (follow.current) {
      element.scrollTop = element.scrollHeight;
      markSeen();
    } else {
      const saved = anchor.current;
      const item =
        saved &&
        [...element.querySelectorAll<HTMLElement>("[data-log-id]")].find(
          (node) => node.dataset.logId === saved.id,
        );
      if (item && saved) {
        element.scrollTop +=
          item.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          saved.offset;
      }
      setUnread(
        messages.filter(
          (message) =>
            message.at >= seen.current.at && !seen.current.ids.has(message.id),
        ).length,
      );
    }
    remember();
  });
  useEffect(() => {
    const element = viewport.current;
    if (!active || !element) return;
    const observer = new ResizeObserver(() => {
      if (element.clientHeight && follow.current) latest();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, scope, messages]);
  return { viewport, following, unread, latest, onScroll };
}

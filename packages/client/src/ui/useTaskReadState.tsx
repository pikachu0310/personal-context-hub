import { useCallback, useEffect, useState } from "react";
import {
  completionVersion,
  taskReadKey,
  type SidebarTask,
} from "./sidebar-tasks.js";

const storageKey = "ido.task-read.v1";
type ReadState = Record<string, string>;
function loadReadState(): ReadState {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    if (value && typeof value === "object" && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).filter((entry) => typeof entry[1] === "string"),
      );
  } catch {
    /* Read indicators still work when browser storage is unavailable. */
  }
  return {};
}

export function useTaskReadState() {
  const [seen, setSeen] = useState<ReadState>(loadReadState);
  const markRead = useCallback((key: string, version: string) => {
    setSeen((previous) => {
      if (previous[key] === version) return previous;
      // Merge other windows' markers before writing; store identifiers, never task text.
      const next = { ...previous, ...loadReadState(), [key]: version };
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* Keep the in-memory marker. */
      }
      return next;
    });
  }, []);
  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key === storageKey || event.key === null)
        setSeen(loadReadState());
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, []);
  return { seen, markRead };
}

/** Merely selecting a task in a background window must not acknowledge its result. */
export function TaskReadObserver({
  scope,
  item,
  markRead,
}: {
  scope: string;
  item?: SidebarTask;
  markRead: (key: string, version: string) => void;
}) {
  const key = item && taskReadKey(scope, item);
  const version = item && completionVersion(item);
  useEffect(() => {
    const observe = () => {
      if (
        key &&
        version &&
        document.visibilityState === "visible" &&
        document.hasFocus()
      )
        markRead(key, version);
    };
    observe();
    window.addEventListener("focus", observe);
    document.addEventListener("visibilitychange", observe);
    return () => {
      window.removeEventListener("focus", observe);
      document.removeEventListener("visibilitychange", observe);
    };
  }, [key, version, markRead]);
  return null;
}

import { Icon } from "./Icons.js";
import { useState, type ReactNode } from "react";
export function Collapsible({
  storageKey,
  title,
  actions,
  children,
  className,
}: {
  storageKey: string;
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const key = "ido.sidebar.collapse." + storageKey;
  const [closed, setClosed] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  return (
    <div className={className}>
      <div className="collapse-heading">
        <button
          type="button"
          className="collapse-toggle"
          aria-expanded={!closed}
          onClick={() => {
            setClosed(!closed);
            try {
              localStorage.setItem(key, closed ? "0" : "1");
            } catch {
              /* Storage may be disabled. */
            }
          }}
        >
          <span
            aria-hidden="true"
            style={{
              display: "flex",
              transform: closed ? undefined : "rotate(90deg)",
            }}
          >
            <Icon name="chevron" size={15} />
          </span>
          {title}
        </button>
        {actions}
      </div>
      <div hidden={closed}>{children}</div>
    </div>
  );
}

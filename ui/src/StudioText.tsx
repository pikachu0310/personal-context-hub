import { memo, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Clipboard } from "lucide-react";

export const StudioText = memo(function StudioText({
  text,
  copy = false,
}: {
  text: string;
  copy?: boolean;
}) {
  const [copied, setCopied] = useState("");
  useEffect(() => setCopied(""), [text]);
  return (
    <div className="studio-document">
      {copy && (
        <div className="document-actions">
          <button
            className="button-secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                setCopied("コピーしました");
              } catch {
                setCopied("本文を選択してコピーしてください");
              }
            }}
          >
            {copied === "コピーしました" ? (
              <Check size={14} />
            ) : (
              <Clipboard size={14} />
            )}
            本文をコピー
          </button>
          <span role="status">{copied}</span>
        </div>
      )}
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) => (/^(https?:\/\/|mailto:)/i.test(url) ? url : "")}
        components={{
          h1: ({ children }) => <h3>{children}</h3>,
          h2: ({ children }) => <h3>{children}</h3>,
          h3: ({ children }) => <h4>{children}</h4>,
          img: ({ alt }) => (
            <span className="muted">{alt ? `画像：${alt}` : "画像"}</span>
          ),
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          table: ({ children }) => (
            <div
              className="document-table"
              tabIndex={0}
              role="region"
              aria-label="結果の表"
            >
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});

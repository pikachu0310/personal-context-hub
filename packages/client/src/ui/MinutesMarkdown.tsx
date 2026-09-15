import { handlePreviewLink } from "./preview-links.js";
import { parsePreviewUrl } from "@ido/common/contracts/api";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseTaskUrl, type TaskReference } from "@ido/common/contracts/api";
import { minutesUrl } from "./minutes-url.js";
export function MinutesMarkdown({
  text,
  openTask,
}: {
  text: string;
  openTask: (reference: TaskReference) => void;
}) {
  return (
    <div className="minutes-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={minutesUrl}
        components={{
          a: ({ href, children }) => {
            if (href && parsePreviewUrl(href))
              return (
                <a
                  className="minutes-task-link"
                  href="#preview"
                  onAuxClick={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.preventDefault();
                    handlePreviewLink(href);
                  }}
                >
                  {children}
                  <span aria-hidden="true"> ▷</span>
                </a>
              );
            const reference = href && parseTaskUrl(href);
            if (reference)
              return (
                <a
                  className="minutes-task-link"
                  href={`#projects/${reference.projectId}/tasks/${reference.taskId}`}
                  onAuxClick={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.preventDefault();
                    openTask(reference);
                  }}
                >
                  {children}
                  <span aria-hidden="true"> ↗</span>
                </a>
              );
            return href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span title="利用できないリンク">{children}</span>
            );
          },
          img: ({ src, alt }) =>
            typeof src === "string" && /^https?:\/\//i.test(src) ? (
              <a href={src} target="_blank" rel="noopener noreferrer">
                {alt || "画像を開く"}
              </a>
            ) : (
              <span>{alt || "画像"}</span>
            ),
          table: ({ children }) => (
            <div
              className="minutes-table"
              role="region"
              aria-label="議事録の表"
              tabIndex={0}
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
}

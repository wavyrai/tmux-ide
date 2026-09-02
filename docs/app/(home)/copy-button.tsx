"use client";

import { useState, useCallback } from "react";

type CopyStatus = "idle" | "copied" | "error";

function fallbackCopy(text: string): boolean {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  try {
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}

export function CopyButton({
  text,
  className,
  children,
}: {
  text: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<CopyStatus>("idle");

  const copy = useCallback(async () => {
    let copied = false;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      } else {
        copied = fallbackCopy(text);
      }
    } catch {
      copied = fallbackCopy(text);
    }

    setStatus(copied ? "copied" : "error");
    setTimeout(() => setStatus("idle"), copied ? 2000 : 4000);
  }, [text]);

  return (
    <button
      type="button"
      onClick={copy}
      className={className}
      aria-label={status === "copied" ? "Copied to clipboard" : "Copy install command"}
    >
      {status === "copied" ? (
        <span className="marketing-feedback-enter inline-flex items-center gap-2">
          <svg
            aria-hidden="true"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline className="copy-check-path" points="20 6 9 17 4 12" />
          </svg>
          Copied!
        </span>
      ) : (
        children
      )}
      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {status === "copied"
          ? "Install command copied to clipboard."
          : status === "error"
            ? "Could not copy the install command. Select the command and copy it manually."
            : ""}
      </span>
    </button>
  );
}

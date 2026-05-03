"use client";

import { useEffect } from "react";
import { useToasts, type Toast, type ToastInput } from "@/lib/useToasts";

declare global {
  interface Window {
    __pushTestToast?: (toast: ToastInput) => string;
  }
}

const stripeByKind: Record<Toast["kind"], string> = {
  info: "var(--cyan)",
  success: "var(--green)",
  error: "var(--red)",
  warning: "var(--yellow)",
};

export function ToastStack() {
  const { toasts, push, dismiss } = useToasts();

  useEffect(() => {
    window.__pushTestToast = push;
    return () => {
      delete window.__pushTestToast;
    };
  }, [push]);

  return (
    <div
      data-testid="toast-stack"
      className="fixed bottom-10 left-1/2 z-50 flex w-[min(360px,calc(100vw-32px))] -translate-x-1/2 flex-col gap-2 md:left-auto md:right-4 md:translate-x-0"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-testid="toast"
          data-kind={toast.kind}
          className="relative overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg-strong)] px-3 py-2 pr-9 shadow-2xl"
        >
          <div
            className="absolute bottom-0 left-0 top-0 w-1"
            style={{ backgroundColor: stripeByKind[toast.kind] }}
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="truncate text-[13px] text-[var(--fg)]">{toast.title}</div>
            {toast.body && (
              <div className="mt-0.5 text-[12px] leading-5 text-[var(--dim)]">{toast.body}</div>
            )}
            {toast.actionLabel && toast.onAction && (
              <button
                type="button"
                onClick={() => {
                  toast.onAction?.();
                  dismiss(toast.id);
                }}
                className="mt-2 text-[12px] text-[var(--accent)] hover:underline"
              >
                {toast.actionLabel}
              </button>
            )}
          </div>
          <button
            type="button"
            aria-label={`Dismiss ${toast.title}`}
            onClick={() => dismiss(toast.id)}
            className="absolute right-2 top-2 text-[var(--dim)] transition-colors hover:text-[var(--fg)]"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

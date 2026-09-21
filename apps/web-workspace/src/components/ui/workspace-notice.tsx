import type { ComponentProps, ReactNode } from "react";

type WorkspaceNoticeProps = ComponentProps<"div"> & {
  actions?: ReactNode;
  tone?: "neutral" | "warning" | "error";
};

/** Compact feedback that leaves the terminal workbench in place. */
export function WorkspaceNotice({
  children,
  actions,
  tone = "neutral",
  role = "status",
  className = "",
  ...props
}: WorkspaceNoticeProps) {
  return (
    <div
      data-slot="workspace-notice"
      data-tone={tone}
      className={`workspace-notice ${className}`}
      role={role}
      {...props}
    >
      <span data-slot="workspace-notice-message" className="workspace-notice-message">
        {children}
      </span>
      {actions && (
        <span data-slot="workspace-notice-actions" className="workspace-notice-actions">
          {actions}
        </span>
      )}
    </div>
  );
}

"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PanelProps {
  variant?: "shrink" | "grow";
  width?: number;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
  testId?: string;
}

export function Panel({
  variant = "grow",
  width,
  className,
  style,
  children,
  testId,
}: PanelProps) {
  return (
    <div
      data-slot="panel"
      data-testid={testId}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--bg)]",
        variant === "grow" && "flex-1",
        variant === "shrink" && "shrink-0",
        className,
      )}
      style={{
        ...(variant === "shrink" && width !== undefined ? { width } : {}),
        ...style,
      }}
    >
      {children}
    </div>
  );
}

interface PanelHeaderProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  badge?: ReactNode;
  leadingAction?: ReactNode;
  actions?: ReactNode;
  className?: string;
  testId?: string;
}

export function PanelHeader({
  title,
  subtitle,
  badge,
  leadingAction,
  actions,
  className,
  testId,
}: PanelHeaderProps) {
  return (
    <header
      data-slot="panel-header"
      data-testid={testId}
      className={cn(
        "flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-weak)] bg-[var(--bg-weak)] px-3 text-[12px]",
        className,
      )}
    >
      {leadingAction}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {title && (
          <span className="truncate text-[var(--fg)] font-medium tracking-[-0.005em]">
            {title}
          </span>
        )}
        {badge}
        {subtitle && (
          <span className="truncate text-[11px] text-[var(--dim)]">{subtitle}</span>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </header>
  );
}

interface PanelBodyProps {
  className?: string;
  children: ReactNode;
  scrollable?: boolean;
}

export function PanelBody({ className, children, scrollable = true }: PanelBodyProps) {
  return (
    <div
      data-slot="panel-body"
      className={cn(
        "flex min-h-0 min-w-0 flex-1 flex-col",
        scrollable && "overflow-auto",
        !scrollable && "overflow-hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

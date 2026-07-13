import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** The system UI stack — SF Pro on a Mac, the platform's own UI font elsewhere.
 *  Deliberately NOT Geist: a macOS titlebar rendered in a webfont reads as a
 *  drawing of a window rather than a window. */
const MAC_UI_FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif';

/**
 * A macOS window. Real proportions: a 38px titlebar, 12px traffic lights inset
 * 14px from the left, the Aqua vertical gradient with its top highlight and
 * bottom hairline, and the document title centered on the WINDOW rather than on
 * the leftover space — that last one is the detail that usually gives fakes away.
 */
export function MacWindow({
  title,
  children,
  accessory,
  footer,
  className,
}: {
  title: string;
  children: ReactNode;
  /** Right side of the titlebar (e.g. the agent cast). */
  accessory?: ReactNode;
  /** A strip under the content, inside the window. */
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[10px] border border-black/60 bg-[#09090b]",
        "shadow-[0_24px_60px_-12px_rgba(0,0,0,0.55),0_0_0_0.5px_rgba(255,255,255,0.08)_inset]",
        className,
      )}
    >
      <div
        className="relative flex h-[38px] items-center px-[14px]"
        style={{
          fontFamily: MAC_UI_FONT,
          background: "linear-gradient(180deg, #3a3a3c 0%, #2c2c2e 100%)",
          boxShadow: "inset 0 -0.5px 0 rgba(0,0,0,0.6), inset 0 0.5px 0 rgba(255,255,255,0.10)",
        }}
      >
        <div className="flex gap-[8px]">
          <span className="h-[12px] w-[12px] rounded-full bg-[#ff5f57] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.2)]" />
          <span className="h-[12px] w-[12px] rounded-full bg-[#febc2e] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.2)]" />
          <span className="h-[12px] w-[12px] rounded-full bg-[#28c840] shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.2)]" />
        </div>
        <span className="pointer-events-none absolute inset-x-0 text-center text-[13px] font-medium text-[#c7c7cc]">
          {title}
        </span>
        <div className="ml-auto flex items-center gap-2.5">{accessory}</div>
      </div>
      <div className="overflow-x-auto bg-[rgb(16,16,22)] p-4">{children}</div>
      {footer ? (
        <div className="border-t border-white/5 bg-[#0d0d10] px-5 py-3.5">{footer}</div>
      ) : null}
    </div>
  );
}

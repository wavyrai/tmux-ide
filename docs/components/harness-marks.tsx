/**
 * A tight cluster of simplified marks for the agent harnesses tmux-ide
 * recognises: Claude Code, Codex and Cursor. Drawn for this site, decorative
 * (aria-hidden); the surrounding control carries the accessible name.
 */
export function HarnessMarks({ className = "" }: { className?: string }) {
  return (
    <span aria-hidden className={`harness-marks ${className}`}>
      {/* Claude Code: a coral burst. */}
      <svg viewBox="0 0 16 16" width="16" height="16" className="harness-mark-claude">
        <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          {[0, 30, 60, 90, 120, 150].map((angle) => (
            <path key={angle} d="M8 2.25v11.5" transform={`rotate(${angle} 8 8)`} />
          ))}
        </g>
      </svg>
      {/* Codex: a soft indigo cloud holding a prompt. */}
      <svg viewBox="0 0 16 16" width="16" height="16" className="harness-mark-codex">
        <g fill="currentColor">
          <circle cx="5.6" cy="5.6" r="3.9" />
          <circle cx="10.4" cy="5.6" r="3.9" />
          <circle cx="5.6" cy="10.4" r="3.9" />
          <circle cx="10.4" cy="10.4" r="3.9" />
        </g>
        <path
          d="m5.25 6.25 2 1.75-2 1.75M8.75 10.25h2.5"
          fill="none"
          className="harness-mark-codex-glyph"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {/* Cursor: an isometric cube. */}
      <svg viewBox="0 0 16 16" width="16" height="16" className="harness-mark-cursor">
        <path d="M8 1.25 14 4.75v6.5L8 14.75l-6-3.5v-6.5z" fill="currentColor" />
        <path
          d="M2.4 4.95 8 8.2l5.6-3.25M8 8.2v6.2"
          fill="none"
          className="harness-mark-cursor-edge"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

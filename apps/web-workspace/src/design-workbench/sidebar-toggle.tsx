import { MorphIcon } from "morphicons/react";
import { useState } from "react";
// Matching stroke geometry keeps the sidebar frame stable while the arrow reverses.
const closeSidebar =
  "M4 3H20Q21 3 21 4V20Q21 21 20 21H4Q3 21 3 20V4Q3 3 4 3Z M9 3V21 M16 9L13 12L16 15";
const openSidebar =
  "M4 3H20Q21 3 21 4V20Q21 21 20 21H4Q3 21 3 20V4Q3 3 4 3Z M9 3V21 M14 9L17 12L14 15";
export function SidebarToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const [keyboard, setKeyboard] = useState(false);
  return (
    <button
      className="dw-button"
      aria-label={open ? "Hide sidebar" : "Show sidebar"}
      aria-expanded={open}
      aria-controls="design-workspace-sidebar"
      title={open ? "Hide sidebar" : "Show sidebar"}
      onClick={(event) => {
        setKeyboard(event.detail === 0);
        onToggle();
      }}
    >
      <MorphIcon
        icon={open ? closeSidebar : openSidebar}
        size="var(--dw-icon-size)"
        strokeWidth={1.5}
        spring="snappy"
        reducedMotion={keyboard ? "always" : "user"}
      />
    </button>
  );
}

import { AgentIcon } from "./agent-icon";
import * as stylex from "@stylexjs/stylex";
import { motion } from "motion/react";
import { useState, useSyncExternalStore } from "react";
import { Terminal, X } from "./icons";
import { spring, useReducedMotion } from "./motion";
import { s } from "./styles";
import { Button } from "./components/ui/button";

const touchQuery = matchMedia("(hover: none)");
const subscribe = (listener: () => void) => {
  touchQuery.addEventListener("change", listener);
  return () => touchQuery.removeEventListener("change", listener);
};

export function PaneHeading({
  label,
  cwd,
  onClose,
  focused: paneFocused = false,
  agent = false,
}: {
  focused?: boolean;
  agent?: boolean;
  label: string;
  cwd: string;
  onClose: () => void;
}) {
  const reduced = useReducedMotion();
  const touch = useSyncExternalStore(
    subscribe,
    () => touchQuery.matches,
    () => true,
  );
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const revealed = touch || hovered || focused;
  const transition = reduced ? { duration: 0 } : spring;

  return (
    <div
      {...stylex.props(s.paneHeading)}
      data-pane-heading
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
        }
      }}
      onFocusCapture={() => setFocused(true)}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") {
          setHovered(true);
        }
      }}
      onPointerLeave={() => setHovered(false)}
    >
      <motion.div
        {...stylex.props(s.paneHideSlot)}
        animate={{ width: revealed ? 40 : 0 }}
        initial={false}
        transition={transition}
      >
        <Button
          {...stylex.props(s.iconButton, s.paneHide)}
          animate={{
            opacity: revealed ? 1 : 0,
            x: revealed || reduced ? 0 : -8,
          }}
          aria-label="Close pane"
          data-pane-hide
          initial={false}
          onClick={onClose}
          style={{ pointerEvents: revealed ? "auto" : "none" }}
          title="Close pane · Active commands keep running"
          transition={transition}
        >
          <X size={16} />
        </Button>
      </motion.div>
      <div {...stylex.props(s.paneLabel)}>
        <span
          className="pane-focus-marker"
          data-focused={paneFocused}
          title={paneFocused ? "Selected pane" : "Inactive pane"}
          aria-label={paneFocused ? "Selected pane" : "Inactive pane"}
        >
          {paneFocused ? "●" : "○"}
        </span>
        {agent && <AgentIcon name={label} size={14} />}
        {!agent && <Terminal size={14} strokeWidth={1.7} {...stylex.props(s.paneIcon)} />}
        <span {...stylex.props(s.paneName)} title={cwd}>
          {label}
        </span>
      </div>
    </div>
  );
}

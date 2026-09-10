import { AgentIcon } from "./agent-icon";
import * as stylex from "@stylexjs/stylex";
import { AnimatePresence } from "motion/react";
import { Activity, Prompt, Sparkles } from "./icons";
import { StateIcon } from "./motion";

const styles = stylex.create({
  back: {
    insetInlineStart: 9,
    opacity: 0.5,
    top: 1,
    transform: "rotate(10deg)",
  },
  blue: {
    backgroundColor: "var(--icon-tile-fill)",
    color: "var(--icon-tile-ink)",
  },
  card: {
    backdropFilter: "blur(16px)",
    backgroundColor: "var(--icon-stack-fill)",
    backgroundImage: "var(--tab-surface)",
    borderRadius: 8,
    boxShadow: "var(--tab-shadow)",
    height: 19,
    position: "absolute",
    width: 23,
  },
  face: {
    alignItems: "center",
    backdropFilter: "blur(16px)",
    backgroundColor: "var(--icon-tile-fill)",
    backgroundImage: "var(--tab-surface)",
    borderRadius: 9,
    boxShadow: "var(--tab-shadow)",
    color: "var(--icon-tile-ink)",
    display: "flex",
    height: 20,
    justifyContent: "center",
    padding: 3,
    position: "relative",
    transform: "rotate(-5deg)",
    width: 23,
  },
  middle: {
    insetInlineStart: 5,
    opacity: 0.8,
    top: 2,
    transform: "rotate(5deg)",
  },
  peach: {
    backgroundColor: "var(--icon-tile-fill)",
    color: "var(--icon-tile-ink)",
  },
  screen: {
    alignItems: "center",
    borderRadius: 5,
    color: "inherit",
    display: "flex",
    height: "100%",
    justifyContent: "center",
    width: "100%",
  },
  stack: {
    alignItems: "center",
    display: "inline-flex",
    flexShrink: 0,
    height: 24,
    isolation: "isolate",
    justifyContent: "flex-start",
    position: "relative",
    width: 30,
  },
});
export function GlassIcon({ count = 1, command = "zsh" }: { count?: number; command?: string }) {
  const activity = /^(btop|htop|top|bottom)$/.test(command),
    agent = /(claude|codex|opencode)/.test(command);
  const Glyph = activity ? Activity : agent ? Sparkles : Prompt;
  return (
    <span {...stylex.props(styles.stack)} aria-hidden="true" data-glass-icon>
      {count > 2 && <span {...stylex.props(styles.card, styles.back)} />}
      {count > 1 && <span {...stylex.props(styles.card, styles.middle)} />}
      <span {...stylex.props(styles.face, activity && styles.blue, agent && styles.peach)}>
        <span {...stylex.props(styles.screen)}>
          <AnimatePresence initial={false} mode="wait">
            <StateIcon key={activity ? "activity" : agent ? "agent" : "shell"}>
              {agent ? (
                <AgentIcon name={command} size={16} />
              ) : (
                <Glyph size={16} strokeWidth={1.8} />
              )}
            </StateIcon>
          </AnimatePresence>
        </span>
      </span>
    </span>
  );
}

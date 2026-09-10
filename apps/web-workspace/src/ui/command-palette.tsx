import * as stylex from "@stylexjs/stylex";
import { Command } from "cmdk";
import { motion } from "motion/react";
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Search } from "../icons";
import { pressSpring, spring, useReducedMotion } from "../motion";
import { s } from "../styles";
import { Button } from "./button";
import { Dialog } from "./dialog";

const MotionList = motion.create(Command.List);
const MotionItem = motion.create(Command.Item);

export interface CommandItem {
  disabled?: boolean;
  hint?: ReactNode;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  value: string;
}
export interface CommandGroup {
  items: CommandItem[];
  label: string;
}

export function CommandPalette({
  groups,
  query,
  onQueryChange,
  status,
}: {
  groups: CommandGroup[];
  query: string;
  onQueryChange: (value: string) => void;
  status: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const [selected, setSelected] = useState("");
  const [height, setHeight] = useState<number | "auto">("auto");
  const [moreBelow, setMoreBelow] = useState(false);
  const updateOverflow = useCallback(() => {
    const element = list.current;
    setMoreBelow(
      Boolean(element && element.scrollHeight - element.clientHeight - element.scrollTop > 8),
    );
  }, []);

  useLayoutEffect(() => {
    const listElement = list.current;
    const content = listElement?.querySelector<HTMLElement>("[cmdk-list-sizer]");
    if (!(content && listElement)) {
      return;
    }
    const measure = () =>
      setHeight(
        Math.min(
          content.getBoundingClientRect().height,
          360,
          Math.max(96, window.innerHeight - 220),
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    const overflowObserver = new ResizeObserver(updateOverflow);
    overflowObserver.observe(listElement);
    overflowObserver.observe(content);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      overflowObserver.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [updateOverflow]);

  return (
    <Command
      label="Search commands"
      loop
      onValueChange={setSelected}
      value={selected}
      {...stylex.props(s.paletteRoot)}
    >
      <div {...stylex.props(s.paletteSearch)}>
        <span {...stylex.props(s.paletteSearchIcon)}>
          <Search size={20} />
        </span>
        <Command.Input
          onValueChange={onQueryChange}
          ref={input}
          value={query}
          {...stylex.props(s.paletteInput)}
          placeholder="Search commands…"
        />
        <Dialog.Close
          render={<Button />}
          {...stylex.props(s.paletteEscape)}
          aria-label="Close dialog"
          title="Close · Esc"
        >
          <kbd>Esc</kbd>
        </Dialog.Close>
      </div>
      <MotionList
        ref={list}
        {...stylex.props(s.paletteList)}
        animate={{ height }}
        aria-label="Commands and open tabs"
        initial={false}
        onScroll={updateOverflow}
        transition={reduced ? { duration: 0 } : spring}
      >
        <Command.Empty>
          <div {...stylex.props(s.paletteEmpty)}>
            <span>No commands or tabs match “{query}”.</span>
            <Button
              {...stylex.props(s.textButton)}
              onClick={() => {
                onQueryChange("");
                input.current?.focus();
              }}
            >
              Clear search
            </Button>
          </div>
        </Command.Empty>
        {groups.map((group) => (
          <Command.Group
            heading={<span {...stylex.props(s.paletteGroupHeading)}>{group.label}</span>}
            key={group.label}
            {...stylex.props(s.paletteGroup)}
          >
            {group.items.map((item) => (
              <MotionItem
                disabled={item.disabled}
                key={item.value}
                keywords={[item.label]}
                onSelect={item.onSelect}
                value={item.value}
                {...stylex.props(
                  s.paletteItem,
                  selected === item.value && s.paletteSelected,
                  item.disabled && s.paletteDisabled,
                )}
                animate={{ scale: 1 }}
                transition={reduced ? { duration: 0 } : pressSpring}
                whileTap={reduced || item.disabled ? undefined : { scale: 0.985 }}
              >
                <span {...stylex.props(s.paletteItemIcon)}>{item.icon}</span>
                <span {...stylex.props(s.paletteItemLabel)} title={item.label}>
                  {item.label}
                </span>
                <span
                  {...stylex.props(s.paletteHint, selected === item.value && s.paletteSelectedHint)}
                >
                  {typeof item.hint === "string" && item.hint.startsWith("⌘")
                    ? [...item.hint].map((key) => (
                        <kbd key={key} {...stylex.props(s.paletteKey)}>
                          {key}
                        </kbd>
                      ))
                    : item.hint}
                </span>
                <span {...stylex.props(s.paletteReturn)} aria-hidden="true">
                  {selected === item.value ? "↵" : ""}
                </span>
              </MotionItem>
            ))}
          </Command.Group>
        ))}
      </MotionList>
      <div {...stylex.props(s.paletteFooter)}>
        <span {...stylex.props(s.paletteStatus)}>{status}</span>
        {Boolean(moreBelow) && (
          <span {...stylex.props(s.paletteMore)} aria-hidden="true">
            More below ↓
          </span>
        )}
        <span {...stylex.props(s.paletteHelp)} aria-hidden="true">
          <span>
            <kbd {...stylex.props(s.paletteKey)}>↑</kbd>
            <kbd {...stylex.props(s.paletteKey)}>↓</kbd> Navigate
          </span>
          <span>
            <kbd {...stylex.props(s.paletteKey)}>↵</kbd> Open
          </span>
        </span>
      </div>
    </Command>
  );
}

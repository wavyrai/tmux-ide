import * as stylex from "@stylexjs/stylex";
import { motion, useIsPresent } from "motion/react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { X } from "./icons";
import { spring, useReducedMotion } from "./motion";
import { s } from "./styles";
import { Button } from "./components/ui/button";
import { Dialog } from "./components/ui/dialog";
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide = false,
  variant = "default",
  error,
  onDismissError,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  variant?: "default" | "command";
  error?: string;
  onDismissError?: () => void;
}) {
  const [moreBelow, setMoreBelow] = useState(false);
  const [opener] = useState(() => document.activeElement);
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  const setPopupRef = useCallback((element: HTMLDivElement | null) => {
    ref.current = element;
    setPopup(element);
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: This effect deliberately reruns when the rendered layout changes, even though those values are not read inside the DOM measurement.
  useEffect(() => {
    const el = popup;
    if (!el) {
      return;
    }
    const update = () => setMoreBelow(el.scrollHeight - el.clientHeight - el.scrollTop > 8);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [children, popup]);
  return (
    <Dialog.Root
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      open={present}
    >
      <Dialog.Portal keepMounted>
        <Dialog.Viewport
          {...stylex.props(s.overlay)}
          render={
            <motion.div
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              transition={{ ...spring, duration: 0.15 }}
            />
          }
        >
          <Dialog.Popup
            finalFocus={() => {
              // Commands may explicitly move to terminal Find before the exit completes.
              const target = document.activeElement;
              if (
                target instanceof HTMLElement &&
                target !== document.body &&
                !ref.current?.contains(target) &&
                !target.closest("[inert]")
              ) {
                return false;
              }
              // Restoring the last background tab removes its count button.
              // Return to a useful workspace control when the opener is gone.
              if (!opener?.isConnected || opener === document.body) {
                return true;
              }
              return true;
            }}
            initialFocus={(type) => (type === "touch" ? ref.current : true)}
            ref={setPopupRef}
            {...stylex.props(s.modal, wide && s.modalWide, variant === "command" && s.paletteModal)}
            render={
              <motion.div
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 8 }}
                initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 12 }}
                transition={spring}
              />
            }
          >
            {variant === "command" ? (
              <Dialog.Title {...stylex.props(s.srOnly)}>{title}</Dialog.Title>
            ) : (
              <div {...stylex.props(s.modalHeader)}>
                <Dialog.Title {...stylex.props(s.modalTitle)}>{title}</Dialog.Title>
                <Dialog.Close
                  render={<Button />}
                  {...stylex.props(s.iconButton)}
                  aria-label="Close dialog"
                >
                  <X size={17} />
                </Dialog.Close>
              </div>
            )}
            {Boolean(subtitle) && (
              <Dialog.Description {...stylex.props(s.paragraph)}>{subtitle}</Dialog.Description>
            )}
            {Boolean(error) && (
              <div
                role="alert"
                {...stylex.props(s.inlineNotice, variant === "command" && s.paletteNotice)}
              >
                <span>{error}</span>
                <Button
                  {...stylex.props(s.iconButton, s.tinyButton)}
                  aria-label="Dismiss notification"
                  onClick={onDismissError}
                >
                  <X size={15} />
                </Button>
              </div>
            )}
            {children}
            {variant !== "command" && (
              <div {...stylex.props(s.scrollCuePosition)} aria-hidden="true">
                {Boolean(moreBelow) && <span {...stylex.props(s.scrollCue)}>More below ↓</span>}
              </div>
            )}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

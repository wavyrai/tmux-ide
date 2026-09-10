import { type HTMLMotionProps, motion } from "motion/react";
import { useSyncExternalStore } from "react";

// Motion's installed hook captures the initial value; subscribe for live OS changes.
const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
const subscribe = (listener: () => void) => {
  reducedQuery.addEventListener("change", listener);
  return () => reducedQuery.removeEventListener("change", listener);
};
export function useReducedMotion() {
  return useSyncExternalStore(
    subscribe,
    () => reducedQuery.matches,
    () => true,
  );
}

// One motion language for controls and overlays. Terminal output/layout is immediate.
export const spring = { bounce: 0, duration: 0.3, type: "spring" } as const;
export const pressSpring = {
  bounce: 0,
  duration: 0.18,
  type: "spring",
} as const;

export function StateIcon({ children, ...props }: HTMLMotionProps<"span">) {
  const reduced = useReducedMotion();
  const hidden = reduced ? { opacity: 0 } : { filter: "blur(4px)", opacity: 0, scale: 0.25 };
  return (
    <motion.span
      animate={{ filter: "blur(0px)", opacity: 1, scale: 1 }}
      exit={hidden}
      initial={hidden}
      style={{ display: "inline-flex" }}
      transition={spring}
      {...props}
    >
      {children}
    </motion.span>
  );
}

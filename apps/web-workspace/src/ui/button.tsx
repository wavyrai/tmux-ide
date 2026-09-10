import { Button as Primitive } from "@base-ui/react/button";
import { type HTMLMotionProps, motion } from "motion/react";
import { pressSpring, useReducedMotion } from "../motion";

const MotionButton = motion.create(Primitive);
export type ButtonProps = HTMLMotionProps<"button"> &
  Pick<Primitive.Props, "render" | "nativeButton" | "focusableWhenDisabled"> & {
    static?: boolean;
  };

export function Button({ static: isStatic = false, ...props }: ButtonProps) {
  const reduced = useReducedMotion();
  return (
    <MotionButton
      animate={isStatic ? undefined : { scale: 1 }}
      transition={reduced ? { duration: 0 } : pressSpring}
      whileTap={isStatic || reduced || props.disabled ? undefined : { scale: 0.96 }}
      {...props}
    />
  );
}

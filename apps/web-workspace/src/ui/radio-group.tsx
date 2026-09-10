import { Radio } from "@base-ui/react/radio";
import { RadioGroup as Group } from "@base-ui/react/radio-group";
import { motion } from "motion/react";
import { pressSpring, useReducedMotion } from "../motion";

function Item(props: Radio.Root.Props) {
  const reduced = useReducedMotion();
  return (
    <Radio.Root
      nativeButton
      render={
        <motion.button
          animate={{ scale: 1 }}
          transition={reduced ? { duration: 0 } : pressSpring}
          whileTap={reduced || props.disabled ? undefined : { scale: 0.96 }}
        />
      }
      {...props}
    />
  );
}

export const RadioGroup = { Item, Root: Group };

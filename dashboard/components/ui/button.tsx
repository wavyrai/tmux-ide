"use client";

import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "no-highlight inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-[12px] font-medium outline-none transition-[color,background-color,border-color,box-shadow,opacity,transform] duration-150 ease-smooth focus-visible:focus-ring motion-safe:active:scale-[0.97] motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 [&>svg]:size-4 [&>svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-[var(--accent)] bg-[var(--accent)] text-[var(--bg)] hover-only:hover:opacity-90",
        destructive:
          "border border-[var(--red)] bg-[var(--red)] text-[var(--bg)] hover-only:hover:opacity-90",
        outline:
          "border border-[var(--border)] bg-transparent text-[var(--fg)] hover-only:hover:bg-[var(--surface-hover)]",
        secondary:
          "border border-[var(--border-weak)] bg-[var(--surface)] text-[var(--fg)] hover-only:hover:bg-[var(--surface-hover)]",
        ghost:
          "text-[var(--fg-secondary)] hover-only:hover:bg-[var(--surface-hover)] hover-only:hover:text-[var(--fg)]",
        link: "h-auto p-0 text-[var(--cyan)] underline-offset-4 hover-only:hover:underline",
      },
      size: {
        xs: "h-6 px-2 text-[10px]",
        sm: "h-7 px-2 text-[11px]",
        default: "h-8 px-3",
        lg: "h-9 px-4",
        "icon-xs": "size-6",
        "icon-sm": "size-7",
        icon: "size-8",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    isPending?: boolean;
  };

function Button({
  className,
  variant,
  size,
  isPending = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || isPending}
      {...props}
    >
      {isPending && <Loader2 aria-hidden="true" className="animate-spin" />}
      {children}
    </ButtonPrimitive>
  );
}

export { Button, buttonVariants };
export type { ButtonProps };

"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";

const sideClasses = {
  left: "inset-y-0 left-0 h-full w-3/4 max-w-sm border-r data-closed:-translate-x-full",
  right: "inset-y-0 right-0 h-full w-3/4 max-w-sm border-l data-closed:translate-x-full",
  top: "inset-x-0 top-0 h-auto border-b data-closed:-translate-y-full",
  bottom: "inset-x-0 bottom-0 h-auto border-t data-closed:translate-y-full",
};

type DialogContentProps = DialogPrimitive.Popup.Props & {
  side?: keyof typeof sideClasses;
  showClose?: boolean;
};

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-[14px] font-medium text-[var(--fg)]", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-[11px] leading-5 text-[var(--dim)]", className)}
      {...props}
    />
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-1.5 text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("mt-auto flex flex-col gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  side,
  showClose = true,
  ...props
}: DialogContentProps) {
  const sheet = side
    ? sideClasses[side]
    : "left-1/2 top-1/2 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 data-closed:scale-95";

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Backdrop
        data-slot="dialog-backdrop"
        className="fixed inset-0 z-40 bg-[var(--modal-overlay)] transition-opacity duration-150 ease-smooth data-closed:opacity-0 data-open:opacity-100 motion-reduce:transition-none"
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "fixed z-40 flex flex-col rounded-md border-[var(--border)] bg-[var(--bg-strong)] shadow-2xl outline-none transition-[transform,opacity] duration-150 ease-smooth data-closed:opacity-0 data-open:opacity-100 motion-reduce:transition-none",
          sheet,
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            render={<Button variant="ghost" size="icon-sm" />}
            className="absolute right-2 top-2 text-[var(--dim)]"
            aria-label="Close"
          >
            <X aria-hidden="true" size={15} />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
};

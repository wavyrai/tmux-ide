"use client";

import { cva, type VariantProps } from "class-variance-authority";
import { PanelLeftIcon } from "lucide-react";
import * as React from "react";
import type { ReactElement } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog";
import { Skeleton } from "./Skeleton";
import { Separator } from "./separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./tooltip";

const SIDEBAR_COOKIE_NAME = "sidebar:state";
const SIDEBAR_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const SIDEBAR_WIDTH = "14rem";
const SIDEBAR_WIDTH_MOBILE = "18rem";
const SIDEBAR_WIDTH_ICON = "3rem";
const SIDEBAR_DEFAULT_KEYBIND = "Mod+b";
const MOBILE_QUERY = "(max-width: 767px)";

type SidebarContextProps = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean | ((open: boolean) => boolean)) => void;
  openMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar() {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }

  return context;
}

function readSidebarCookie(): boolean | null {
  if (typeof document === "undefined") return null;
  const row = document.cookie
    .split("; ")
    .find((item) => item.startsWith(`${SIDEBAR_COOKIE_NAME}=`));
  if (!row) return null;
  const value = row.slice(SIDEBAR_COOKIE_NAME.length + 1);
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return isMobile;
}

function keybindMatches(event: KeyboardEvent, keybind: string) {
  const parts = keybind.split("+").map((part) => part.trim().toLowerCase());
  const key = parts.pop();
  if (!key || event.key.toLowerCase() !== key) return false;

  const wantsMod = parts.includes("mod");
  const wantsMeta = parts.includes("cmd") || parts.includes("meta");
  const wantsCtrl = parts.includes("ctrl") || parts.includes("control");
  const wantsShift = parts.includes("shift");
  const wantsAlt = parts.includes("alt") || parts.includes("option");

  if (wantsMod) {
    if (!event.metaKey && !event.ctrlKey) return false;
  } else {
    if (event.metaKey !== wantsMeta) return false;
    if (event.ctrlKey !== wantsCtrl) return false;
  }
  return event.shiftKey === wantsShift && event.altKey === wantsAlt;
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  keyboardShortcut = SIDEBAR_DEFAULT_KEYBIND,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  keyboardShortcut?: string | null;
}) {
  const isMobile = useIsMobile();
  const [openMobile, setOpenMobile] = React.useState(false);
  const [_open, _setOpen] = React.useState(() => readSidebarCookie() ?? defaultOpen);
  const open = openProp ?? _open;

  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value;
      if (setOpenProp) setOpenProp(openState);
      else _setOpen(openState);
      document.cookie = `${SIDEBAR_COOKIE_NAME}=${openState}; path=/; max-age=${SIDEBAR_COOKIE_MAX_AGE}`;
    },
    [open, setOpenProp],
  );

  const toggleSidebar = React.useCallback(() => {
    if (isMobile) setOpenMobile((value) => !value);
    else setOpen((value) => !value);
  }, [isMobile, setOpen]);

  React.useEffect(() => {
    if (!keyboardShortcut || keyboardShortcut === "none") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !keybindMatches(event, keyboardShortcut)) return;
      event.preventDefault();
      toggleSidebar();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [keyboardShortcut, toggleSidebar]);

  const state = open ? "expanded" : "collapsed";
  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
    }),
    [isMobile, open, openMobile, setOpen, state, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider delay={200}>
        <div
          data-slot="sidebar-wrapper"
          data-sidebar-state={state}
          style={
            {
              "--sidebar-width": SIDEBAR_WIDTH,
              "--sidebar-width-icon": SIDEBAR_WIDTH_ICON,
              ...style,
            } as React.CSSProperties
          }
          className={cn("group/sidebar-wrapper flex min-h-0 flex-1", className)}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  );
}

function Sidebar({
  side = "left",
  variant = "sidebar",
  collapsible = "offcanvas",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  side?: "left" | "right";
  variant?: "sidebar" | "floating" | "inset";
  collapsible?: "offcanvas" | "icon" | "none";
}) {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar();

  if (collapsible === "none") {
    return (
      <div
        data-slot="sidebar"
        data-sidebar="sidebar"
        className={cn(
          "flex h-full w-[--sidebar-width] flex-col bg-[var(--sidebar-background)] text-[var(--sidebar-foreground)]",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    );
  }

  if (isMobile) {
    return (
      <Dialog open={openMobile} onOpenChange={(open) => setOpenMobile(open)}>
        <DialogContent
          data-sidebar="sidebar"
          data-mobile="true"
          data-testid="mobile-shell-drawer"
          side={side}
          showClose={false}
          className={cn("w-[--sidebar-width] p-0", className)}
          style={{ "--sidebar-width": SIDEBAR_WIDTH_MOBILE } as React.CSSProperties}
          {...props}
        >
          <DialogHeader className="sr-only">
            <DialogTitle>Sidebar</DialogTitle>
            <DialogDescription>Displays the mobile navigation sidebar.</DialogDescription>
          </DialogHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <div
      className={cn(
        "group peer hidden h-full shrink-0 text-[var(--sidebar-foreground)] transition-[width] duration-200 ease-out md:flex",
        "w-[--sidebar-width]",
        "data-[collapsible=offcanvas]:w-0",
        "data-[collapsible=icon]:w-[--sidebar-width-icon]",
        (variant === "floating" || variant === "inset") &&
          "data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+0.75rem)]",
      )}
      data-state={state}
      data-collapsible={state === "collapsed" ? collapsible : ""}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar-container"
    >
      <div
        data-slot="sidebar"
        data-sidebar="sidebar"
        className={cn(
          "relative z-10 flex h-full w-full transition-[width] duration-200 ease-out",
          "group-data-[collapsible=offcanvas]:overflow-hidden",
          "group-data-[collapsible=icon]:w-[--sidebar-width-icon]",
          variant === "floating" || variant === "inset"
            ? "p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+0.75rem)]"
            : "border-r border-[var(--sidebar-border)]",
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar-inner"
          className={cn(
            "flex h-full w-full flex-col bg-[var(--sidebar-background)]",
            variant === "floating" && "rounded-md border border-[var(--sidebar-border)] shadow-lg",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<"button">) {
  const { toggleSidebar, openMobile, open } = useSidebar();

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      data-slot="sidebar-trigger"
      data-testid="mobile-nav-toggle"
      aria-label="Toggle navigation"
      aria-expanded={openMobile || open}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      className={cn(
        "text-[var(--dim)] hover-only:hover:bg-[var(--surface-hover)] hover-only:hover:text-[var(--fg)]",
        className,
      )}
      {...props}
    >
      <PanelLeftIcon aria-hidden="true" size={15} />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  );
}

function SidebarRail({ className, ...props }: React.ComponentProps<"button">) {
  const { toggleSidebar } = useSidebar();

  return (
    <button
      type="button"
      data-sidebar="rail"
      aria-label="Toggle sidebar"
      tabIndex={-1}
      onClick={toggleSidebar}
      title="Toggle sidebar"
      className={cn(
        "no-highlight absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-colors after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent hover-only:hover:after:bg-[var(--sidebar-border)] sm:flex",
        "group-data-[side=left]:-right-4 group-data-[side=right]:left-0",
        className,
      )}
      {...props}
    />
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn("relative flex min-w-0 flex-1 flex-col overflow-hidden", className)}
      {...props}
    />
  );
}

function SidebarInput({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      data-sidebar="input"
      data-slot="sidebar-input"
      className={cn(
        "h-8 w-full rounded-md border border-[var(--sidebar-border)] bg-[var(--bg)] px-2 text-[12px] outline-none focus-within:focus-field-ring",
        className,
      )}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-sidebar="header"
      data-slot="sidebar-header"
      className={cn("flex flex-col gap-2 border-b border-[var(--sidebar-border)] p-3", className)}
      {...props}
    />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-sidebar="footer"
      data-slot="sidebar-footer"
      className={cn(
        "mt-auto flex flex-col gap-2 border-t border-[var(--sidebar-border)] p-3",
        className,
      )}
      {...props}
    />
  );
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>) {
  return (
    <Separator
      data-sidebar="separator"
      data-slot="sidebar-separator"
      className={cn("mx-2 w-auto bg-[var(--sidebar-border)]", className)}
      {...props}
    />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-sidebar="content"
      data-slot="sidebar-content"
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2 group-data-[collapsible=icon]:overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-sidebar="group"
      data-slot="sidebar-group"
      className={cn("relative flex w-full min-w-0 flex-col p-1", className)}
      {...props}
    />
  );
}

function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-sidebar="group-label"
      data-slot="sidebar-group-label"
      className={cn(
        "flex h-8 shrink-0 items-center gap-2 rounded-md px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--dim)] outline-none transition-[margin,opacity] duration-200",
        "group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroupAction({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-sidebar="group-action"
      data-slot="sidebar-group-action"
      className={cn(
        "no-highlight absolute right-3 top-3.5 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-[var(--dim)] outline-none transition-colors hover-only:hover:bg-[var(--sidebar-accent)] hover-only:hover:text-[var(--sidebar-accent-foreground)] focus-visible:focus-ring motion-safe:active:scale-[0.97]",
        "after:absolute after:-inset-2 md:after:hidden",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-sidebar="group-content"
      data-slot="sidebar-group-content"
      className={cn("w-full text-sm", className)}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-sidebar="menu"
      data-slot="sidebar-menu"
      className={cn("flex w-full min-w-0 flex-col gap-1", className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  );
}

const sidebarMenuButtonVariants = cva(
  "peer/menu-button no-highlight flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none transition-[color,background-color,border-color,box-shadow,opacity,width,height,padding] duration-150 ease-smooth hover-only:hover:bg-[var(--sidebar-accent)] hover-only:hover:text-[var(--sidebar-accent-foreground)] focus-visible:focus-ring motion-safe:active:scale-[0.97] motion-reduce:transition-none disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-[var(--sidebar-accent)] data-[active=true]:font-medium data-[active=true]:text-[var(--sidebar-accent-foreground)] [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-2",
  {
    variants: {
      variant: {
        default: "",
        outline:
          "border border-[var(--sidebar-border)] bg-[var(--bg)] hover-only:hover:border-[var(--sidebar-accent)]",
      },
      size: {
        default: "h-8 text-sm",
        sm: "h-7 text-xs",
        lg: "h-12 text-sm group-data-[collapsible=icon]:p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function SidebarMenuButton({
  isActive = false,
  variant = "default",
  size = "default",
  tooltip,
  className,
  render,
  ...props
}: Omit<React.ComponentProps<"button">, "size"> & {
  render?: React.ComponentProps<typeof Button>["render"];
  isActive?: boolean;
  tooltip?: string | React.ComponentProps<typeof TooltipContent>;
} & VariantProps<typeof sidebarMenuButtonVariants>) {
  const { isMobile, state } = useSidebar();
  const buttonClassName = cn(sidebarMenuButtonVariants({ variant, size }), className);
  const renderElement =
    render && React.isValidElement(render)
      ? (render as ReactElement<React.HTMLAttributes<HTMLElement>>)
      : null;

  const button = renderElement ? (
    React.cloneElement(renderElement, {
      ...props,
      "data-sidebar": "menu-button",
      "data-slot": "sidebar-menu-button",
      "data-size": size,
      "data-active": isActive,
      className: cn(renderElement.props.className, buttonClassName),
    } as React.HTMLAttributes<HTMLElement>)
  ) : (
    <button
      type="button"
      data-sidebar="menu-button"
      data-slot="sidebar-menu-button"
      data-size={size}
      data-active={isActive}
      className={buttonClassName}
      {...props}
    />
  );

  if (!tooltip || state !== "collapsed" || isMobile) return button;

  const tooltipProps = typeof tooltip === "string" ? { children: tooltip } : tooltip;

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipContent side="right" {...tooltipProps} />
    </Tooltip>
  );
}

function SidebarMenuAction({
  className,
  showOnHover = false,
  ...props
}: React.ComponentProps<"button"> & {
  showOnHover?: boolean;
}) {
  return (
    <button
      type="button"
      data-sidebar="menu-action"
      data-slot="sidebar-menu-action"
      className={cn(
        "no-highlight absolute right-1 top-1.5 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-[var(--dim)] outline-none transition-colors hover-only:hover:bg-[var(--sidebar-accent)] hover-only:hover:text-[var(--sidebar-accent-foreground)] focus-visible:focus-ring motion-safe:active:scale-[0.97]",
        "after:absolute after:-inset-2 md:after:hidden",
        "peer-data-[size=sm]/menu-button:top-1 peer-data-[size=lg]/menu-button:top-2.5",
        "group-data-[collapsible=icon]:hidden",
        showOnHover &&
          "group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 md:opacity-0",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-sidebar="menu-badge"
      data-slot="sidebar-menu-badge"
      className={cn(
        "pointer-events-none absolute right-1 flex h-5 min-w-5 select-none items-center justify-center rounded-md px-1 text-[10px] tabular-nums text-[var(--dim)]",
        "peer-hover/menu-button:text-[var(--sidebar-accent-foreground)] peer-data-[active=true]/menu-button:text-[var(--sidebar-accent-foreground)]",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<"div"> & {
  showIcon?: boolean;
}) {
  return (
    <div
      data-sidebar="menu-skeleton"
      data-slot="sidebar-menu-skeleton"
      className={cn("flex h-8 items-center gap-2 rounded-md px-2", className)}
      {...props}
    >
      {showIcon && <Skeleton className="size-4 shrink-0 rounded-md" />}
      <div
        aria-hidden="true"
        className="h-4 flex-1 animate-pulse rounded-md bg-[var(--surface)]"
        style={{ maxWidth: "70%" }}
      />
    </div>
  );
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-sidebar="menu-sub"
      data-slot="sidebar-menu-sub"
      className={cn(
        "mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-[var(--sidebar-border)] px-2.5 py-0.5",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  );
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-sidebar="menu-sub-item"
      data-slot="sidebar-menu-sub-item"
      className={cn("group/menu-sub-item", className)}
      {...props}
    />
  );
}

function SidebarMenuSubButton({
  size = "md",
  isActive = false,
  className,
  render,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "size"> & {
  size?: "sm" | "md";
  isActive?: boolean;
}) {
  return (
    <Button
      variant="ghost"
      render={render}
      data-sidebar="menu-sub-button"
      data-slot="sidebar-menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        "flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-[var(--fg-secondary)] outline-none hover-only:hover:bg-[var(--sidebar-accent)] hover-only:hover:text-[var(--sidebar-accent-foreground)] focus-visible:focus-ring motion-safe:active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0",
        "data-[active=true]:bg-[var(--sidebar-accent)] data-[active=true]:text-[var(--sidebar-accent-foreground)]",
        size === "sm" && "text-xs",
        size === "md" && "text-sm",
        "group-data-[collapsible=icon]:hidden",
        className,
      )}
      {...props}
    />
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
};

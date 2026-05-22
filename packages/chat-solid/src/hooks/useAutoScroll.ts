import { createEffect, onCleanup, type Accessor } from "solid-js";

const NEAR_BOTTOM_PX = 100;

export function useAutoScroll(
  container: Accessor<HTMLElement | undefined>,
  sentinel: Accessor<HTMLElement | undefined>,
  followSignal: Accessor<string>,
): {
  isFollowing: Accessor<boolean>;
  jumpToBottom(): void;
} {
  let following = true;
  const isFollowing = () => following;

  function updateFromScroll() {
    const el = container();
    if (!el) return;
    following = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }

  createEffect(() => {
    const el = container();
    if (!el) return;
    el.addEventListener("scroll", updateFromScroll, { passive: true });
    onCleanup(() => el.removeEventListener("scroll", updateFromScroll));
  });

  createEffect(() => {
    const target = sentinel();
    if (!target || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) following = entry.isIntersecting;
      },
      { root: container() ?? null, rootMargin: "0px 0px 100px 0px", threshold: 0.01 },
    );
    observer.observe(target);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    followSignal();
    if (!following) return;
    const el = container();
    if (el) el.scrollTop = el.scrollHeight;
  });

  function jumpToBottom() {
    const el = container();
    following = true;
    if (el) el.scrollTop = el.scrollHeight;
  }

  return { isFollowing, jumpToBottom };
}

import Link from "next/link";
import { PrototyperWordmark } from "@/components/prototyper-wordmark";
import { DITHER_MASK_RIGHT, DITHER_SIZE, DITHER_URL } from "@/components/dither";

/** The arrow nudges out on hover — the only motion in the bar. */
function ArrowUpRight() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden
      className="transition-transform duration-150 group-hover:translate-x-px group-hover:-translate-y-px"
    >
      <path
        d="M2 8 8 2M8 2H3.2M8 2v4.8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function TopBanner() {
  return (
    // Sticky above the nav: the banner is the topmost chrome, so it must win the
    // stacking (fumadocs' #nd-nav is sticky top-0 z-40 — global.css pushes it
    // down by the banner's height, and the banner sits at z-50 above it).
    <div className="sticky top-0 z-50 h-10 w-full overflow-hidden bg-black text-white isolate">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          backgroundImage: DITHER_URL,
          backgroundSize: DITHER_SIZE,
          maskImage: DITHER_MASK_RIGHT,
          WebkitMaskImage: DITHER_MASK_RIGHT,
        }}
      />
      {/* Same rail the fumadocs nav uses (layouts/home/client.js): the
          --fd-layout-width container with px-4, so the wordmark lands on the
          same left edge as the tmux-ide logo below it. The var is only defined
          inside the fumadocs layout and this banner sits above it, hence the
          explicit 1400px fallback — fumadocs' own default. */}
      <div className="relative mx-auto flex h-10 w-full max-w-[var(--fd-layout-width,1400px)] items-center px-4">
        <Link
          href="https://www.prototyper.co"
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 text-white transition-opacity hover:opacity-80"
        >
          <PrototyperWordmark width={92} />
          <span className="font-mono text-[10px] tracking-[0.22em] text-white/60">oss</span>
        </Link>

        <Link
          href="https://www.prototyper.co"
          target="_blank"
          rel="noreferrer"
          className="group ml-auto flex items-center gap-1.5 text-xs text-white/70 transition-colors hover:text-white"
        >
          <span className="max-sm:hidden">
            <span className="font-medium text-white">tmux-ide</span> is open source, built at{" "}
            <span className="font-medium text-white">Prototyper</span>.
          </span>
          <span className="inline-flex items-center gap-1 font-medium text-white">
            Learn more
            <ArrowUpRight />
          </span>
        </Link>
      </div>
    </div>
  );
}

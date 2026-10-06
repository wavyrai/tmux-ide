import Link from "next/link";
import { PrototyperWordmark } from "@/components/prototyper-wordmark";
import { DITHER_MASK_RIGHT, DITHER_SIZE, DITHER_URL } from "@/components/dither";
import { SITE_REPOSITORY } from "@/lib/site";

/** The arrow nudges out on hover — the only motion in the bar. */
function ArrowUpRight() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden
      className="marketing-transform-action motion-reduce:transform-none"
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
      {/* Same rail as the landing nav: the --fd-layout-width container with
          the 24px inset global.css gives #nd-nav, so the wordmark lands on
          the same left edge as the tmux-ide logo below it. The var is only defined
          inside the fumadocs layout and this banner sits above it, hence the
          explicit 1400px fallback — fumadocs' own default. */}
      <div className="relative mx-auto flex h-10 w-full max-w-[var(--fd-layout-width,1400px)] items-center px-6">
        <Link
          href="https://www.prototyper.co"
          target="_blank"
          rel="noreferrer"
          aria-label="Prototyper OSS program (opens in a new tab)"
          className="marketing-logo-action flex items-center gap-2 text-white"
        >
          <PrototyperWordmark width={92} />
          <span className="type-caption-3 rounded-full border border-white/25 px-1.5 text-white/75">
            oss
          </span>
        </Link>

        <p className="type-caption-1 ml-auto flex items-center gap-3 text-white/70">
          <span className="max-md:hidden">
            <span className="text-white">tmux-ide</span> is an open-source project by{" "}
            <span className="text-white">Prototyper</span>.
          </span>
          <Link
            href={SITE_REPOSITORY}
            target="_blank"
            rel="noreferrer"
            className="group marketing-banner-link-action inline-flex items-center gap-1 text-white"
          >
            View source
            <ArrowUpRight />
            <span className="sr-only">(opens in a new tab)</span>
          </Link>
        </p>
      </div>
    </div>
  );
}

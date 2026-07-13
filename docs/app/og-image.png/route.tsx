import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "@takumi-rs/image-response";

/**
 * The homepage OG card — 1200×630, served at /og-image.png (the URL the root
 * metadata has always referenced, kept stable for anything that linked it).
 * Replaces the old terminal-mockup card: the icon artwork is the identity now.
 *
 * The icon is the light artwork (the blue tile) read from public/ and embedded
 * as a data URI — takumi renders server-side, where a relative URL has nothing
 * to resolve against. Statically rendered at build; no font plumbing, same as
 * the docs OG route (takumi's bundled default).
 */
export const revalidate = false;
export const dynamic = "force-static";

/** The mirror app's status colors — the card's only accent. */
const STATUS = ["#f06464", "#ebc864", "#78aafa", "#78c88c"] as const;

export function GET() {
  const icon = readFileSync(join(process.cwd(), "public", "icon-light.png"));
  const iconSrc = `data:image/png;base64,${icon.toString("base64")}`;

  return new ImageResponse(
    <div
      tw="flex h-full w-full flex-col justify-between p-20"
      style={{ background: "linear-gradient(160deg, #101016 55%, #0c1a1e 100%)" }}
    >
      <div tw="flex items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={iconSrc} alt="" width={168} height={168} />
        <div tw="ml-12 flex flex-col">
          <div tw="text-8xl font-bold text-white">tmux-ide</div>
          <div tw="mt-3 flex">
            {STATUS.map((c, i) => (
              <div key={i} tw="mr-3 h-4 w-4 rounded-full" style={{ backgroundColor: c }} />
            ))}
          </div>
        </div>
      </div>

      <div tw="flex flex-col">
        <div tw="text-5xl text-white" style={{ lineHeight: 1.25 }}>
          The terminal that understands your agents.
        </div>
        <div tw="mt-8 flex items-center justify-between">
          <div tw="text-3xl" style={{ color: "#6e6e82" }}>
            Adopt any tmux session · ground-truth agent status · crash-proof restore
          </div>
        </div>
        <div tw="mt-10 flex items-center justify-between">
          <div tw="text-2xl" style={{ color: "#57a6a8" }}>
            tmux-ide.com
          </div>
          <div tw="text-2xl" style={{ color: "#6e6e82" }}>
            Prototyper OSS · MIT
          </div>
        </div>
      </div>
    </div>,
    { width: 1200, height: 630, format: "png" },
  );
}

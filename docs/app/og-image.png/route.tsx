import { ImageResponse } from "@takumi-rs/image-response";

import { SocialCard } from "@/components/social-card";
import { SITE_DESCRIPTION } from "@/lib/site";

/**
 * The homepage OG card — 1200×630, served at /og-image.png (the URL the root
 * metadata has always referenced, kept stable for anything that linked it).
 * Homepage card. It shares its visual and messaging system with every docs card
 * so social previews cannot drift away from the site.
 */
export const revalidate = false;
export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(
    <SocialCard
      eyebrow="Build your team of agents"
      title="A dedicated workspace for your coding agents."
      description={SITE_DESCRIPTION}
    />,
    { width: 1200, height: 630, format: "png" },
  );
}

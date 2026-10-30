import type { Metadata } from "next";
import { SITE_IMAGE, SITE_NAME, absoluteUrl } from "@/lib/site";

/**
 * Metadata for a trust page. A page's openGraph replaces the layout's whole
 * object, so og:url, the site name and the share image are set here together.
 */
export function trustMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      locale: "en_US",
      siteName: SITE_NAME,
      url: absoluteUrl(path),
      title: `${title} | ${SITE_NAME}`,
      description,
      images: [{ url: SITE_IMAGE, width: 1200, height: 630, alt: `${title} | ${SITE_NAME}` }],
    },
  };
}

import { getPageImage, source } from "@/lib/source";
import { SocialCard } from "@/components/social-card";
import { SITE_DESCRIPTION } from "@/lib/site";
import { notFound } from "next/navigation";
import { ImageResponse } from "@takumi-rs/image-response";

export const revalidate = false;

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  return new ImageResponse(
    <SocialCard
      eyebrow="tmux-ide documentation"
      title={page.data.title}
      description={page.data.description ?? SITE_DESCRIPTION}
    />,
    {
      width: 1200,
      height: 630,
      format: "webp",
    },
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageImage(page).segments,
  }));
}

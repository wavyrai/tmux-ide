import { getPageImage, source } from "@/lib/source";
import { notFound } from "next/navigation";
import { ImageResponse } from "@takumi-rs/image-response";

export const revalidate = false;

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  return new ImageResponse(
    <div
      style={{
        alignItems: "flex-start",
        background: "#0c0d10",
        color: "#f5f5f4",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        justifyContent: "space-between",
        padding: "72px",
        width: "100%",
      }}
    >
      <div style={{ color: "#67e8f9", display: "flex", fontSize: 34, fontWeight: 700 }}>
        tmux-ide
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 980 }}>
        <div style={{ display: "flex", fontSize: 72, fontWeight: 700, lineHeight: 1.05 }}>
          {page.data.title}
        </div>
        <div style={{ color: "#a8a29e", display: "flex", fontSize: 32, lineHeight: 1.35 }}>
          {page.data.description}
        </div>
      </div>
      <div style={{ color: "#a8a29e", display: "flex", fontSize: 26 }}>
        OpenTUI control plane for the tmux sessions you already own.
      </div>
    </div>,
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

import { readFileSync } from "node:fs";
import { join } from "node:path";

type SocialCardProps = {
  description: string;
  eyebrow: string;
  title: string;
};

const colors = {
  accent: "#67d6ef",
  background: "#0d0d10",
  foreground: "#f5f5f5",
  line: "#2b2b33",
  muted: "#9a9aa3",
  panel: "#15151a",
};

export function getSocialIconSource(): string {
  const icon = readFileSync(join(process.cwd(), "public", "icon-dark.png"));
  return `data:image/png;base64,${icon.toString("base64")}`;
}

function getSocialWordmarkRows(): Array<{ y: number; text: string }> {
  const wordmark = readFileSync(join(process.cwd(), "public", "ascii-wordmark.svg"), "utf8");
  return [...wordmark.matchAll(/<text x="0" y="([0-9]+)">([^<]*)<\/text>/gu)].map(
    ([, y, text]) => ({ y: Number(y), text }),
  );
}

/** Shared 1200×630 social artwork for the homepage and every docs page. */
export function SocialCard({ description, eyebrow, title }: SocialCardProps) {
  const iconSrc = getSocialIconSource();
  const wordmarkRows = getSocialWordmarkRows();

  return (
    <div
      style={{
        background: colors.background,
        color: colors.foreground,
        display: "flex",
        height: "100%",
        padding: "0 64px",
        width: "100%",
      }}
    >
      <div
        style={{
          borderLeft: `1px solid ${colors.line}`,
          borderRight: `1px solid ${colors.line}`,
          display: "flex",
          flexDirection: "column",
          height: "100%",
          width: "100%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            borderBottom: `1px solid ${colors.line}`,
            display: "flex",
            height: 104,
            justifyContent: "space-between",
            padding: "0 44px",
          }}
        >
          <div style={{ alignItems: "center", display: "flex" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={iconSrc} alt="" width={46} height={46} />
            {/* Takumi cannot paint nested SVG text. These rows are read directly
                from the generated SVG, preserving its canonical glyph geometry. */}
            <div
              style={{
                color: colors.foreground,
                display: "flex",
                flexDirection: "column",
                fontFamily: "monospace",
                fontSize: 4.15,
                height: 42,
                lineHeight: 1,
                marginLeft: 16,
                whiteSpace: "pre",
                width: 202,
              }}
            >
              {wordmarkRows.map((row) => (
                <div key={row.y} style={{ display: "flex", height: 6, whiteSpace: "pre" }}>
                  {row.text}
                </div>
              ))}
            </div>
          </div>
          <div
            style={{
              alignItems: "center",
              color: colors.muted,
              display: "flex",
              fontFamily: "monospace",
              fontSize: 17,
            }}
          >
            <span style={{ color: colors.accent, marginRight: 12 }}>Fig. 00.</span>
            agent-aware tmux workspace
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flex: 1,
            flexDirection: "column",
            justifyContent: "center",
            padding: "38px 44px 34px",
          }}
        >
          <div
            style={{
              color: colors.accent,
              display: "flex",
              fontFamily: "monospace",
              fontSize: 19,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
            }}
          >
            {eyebrow}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 60,
              fontWeight: 350,
              letterSpacing: "-0.045em",
              lineHeight: 1.02,
              marginTop: 22,
              maxWidth: 980,
            }}
          >
            {title}
          </div>
          <div
            style={{
              color: colors.muted,
              display: "flex",
              fontSize: 25,
              lineHeight: 1.35,
              marginTop: 24,
              maxWidth: 980,
            }}
          >
            {description}
          </div>
        </div>

        <div
          style={{
            background: colors.panel,
            borderTop: `1px solid ${colors.line}`,
            display: "flex",
            fontFamily: "monospace",
            fontSize: 18,
            height: 78,
          }}
        >
          <SocialCardSignal label="memorable names" marker="●" />
          <SocialCardSignal label="live agent state" marker="◌" />
          <SocialCardSignal label="exact pane navigation" marker="→" last />
        </div>
      </div>
    </div>
  );
}

function SocialCardSignal({
  label,
  marker,
  last = false,
}: {
  label: string;
  marker: string;
  last?: boolean;
}) {
  return (
    <div
      style={{
        alignItems: "center",
        borderRight: last ? undefined : `1px solid ${colors.line}`,
        color: colors.muted,
        display: "flex",
        flex: 1,
        padding: "0 28px",
      }}
    >
      <span style={{ color: colors.accent, marginRight: 12 }}>{marker}</span>
      <span>{label}</span>
    </div>
  );
}

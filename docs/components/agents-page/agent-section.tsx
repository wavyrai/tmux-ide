import Link from "next/link";

import { Band, BandBody, Cell, MarketingGrid } from "@/components/marketing/lattice";
import { TuiMiniFigure } from "@/components/marketing/tui-mini-figure";
import type { AgentSection, CommandLine } from "./content";

const bodyCopy = "type-marketing-body max-w-[62ch] text-fd-muted-foreground";

/**
 * At this page's width the figures are drawn large, and the "You" cursor's
 * name pill lands on the app's text. The arrow alone still shows the action,
 * so the pill is hidden here; the shared figure is unchanged on the homepage.
 */
const figureCursorWithoutLabel = "[&_.tui-cursor-label]:hidden";

/** Plain-text copy with `code` spans. */
function withCode(text: string) {
  return text.split(/(`[^`]+`)/u).map((part, index) =>
    part.startsWith("`") ? (
      <code key={index} className="font-mono text-fd-foreground">
        {part.slice(1, -1)}
      </code>
    ) : (
      part
    ),
  );
}

function Commands({ lines }: { lines: readonly CommandLine[] }) {
  return (
    <pre className="type-caption-1 overflow-x-auto border border-marketing-line bg-marketing-panel px-4 py-3 font-mono text-fd-foreground">
      <code>
        {lines.map(({ command, comment }) => (
          <span key={command} className="block whitespace-pre">
            <span aria-hidden className="mr-2 text-fd-muted-foreground">
              $
            </span>
            {command}
            {comment ? <span className="text-fd-muted-foreground">{`  # ${comment}`}</span> : null}
          </span>
        ))}
      </code>
    </pre>
  );
}

function SectionHeading({ section }: { section: AgentSection }) {
  return (
    <>
      <div className="type-caption-1 flex items-center gap-4 text-fd-muted-foreground">
        <span className="font-mono">{section.index}</span>
        <span>{section.eyebrow}</span>
      </div>
      <h2 id={section.id} className="type-display-4 mt-6 max-w-[22ch] text-fd-foreground">
        {section.title}
      </h2>
    </>
  );
}

function SectionLinks({ section }: { section: AgentSection }) {
  return (
    <ul className="type-body mt-6 flex flex-wrap gap-x-6 gap-y-2">
      {section.links.map((link) => (
        <li key={link.href}>
          <Link href={link.href} className="marketing-link-action text-fd-primary">
            {link.label} →
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * One answer on the page: heading, copy and links on the left, commands and
 * figure on the right. A section without a figure spans the full width, with
 * its paragraphs side by side, so no column is left empty.
 */
export function AgentSectionBand({
  section,
  motionIndex,
}: {
  section: AgentSection;
  motionIndex: number;
}) {
  const { figure } = section;
  if (!figure) {
    return (
      <Band>
        <BandBody>
          <SectionHeading section={section} />
          <div className="mt-4 grid gap-x-6 lg:grid-cols-2">
            {section.body.map((paragraph) => (
              <p key={paragraph} className={`mt-4 ${bodyCopy}`}>
                {withCode(paragraph)}
              </p>
            ))}
          </div>
          <div className="mt-8">
            <Commands lines={section.commands} />
          </div>
          <SectionLinks section={section} />
        </BandBody>
      </Band>
    );
  }

  return (
    <Band>
      <BandBody>
        <MarketingGrid className="items-start">
          <Cell className="lg:col-span-10">
            <SectionHeading section={section} />
            {section.body.map((paragraph) => (
              <p key={paragraph} className={`mt-4 ${bodyCopy}`}>
                {withCode(paragraph)}
              </p>
            ))}
            <SectionLinks section={section} />
          </Cell>
          <Cell className="flex flex-col gap-4 lg:col-span-13 lg:col-start-12">
            <Commands lines={section.commands} />
            <TuiMiniFigure
              variant={figure.variant}
              figure={figure}
              motionCount={3}
              motionIndex={motionIndex}
              className={figureCursorWithoutLabel}
            />
          </Cell>
        </MarketingGrid>
      </BandBody>
    </Band>
  );
}

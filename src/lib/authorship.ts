export interface SectionAuthorship {
  author: string; // 'ai:François' or 'ai:Amélie' or 'human' or 'human:thijs'
  at: string; // ISO timestamp
  charCount: number; // characters in this section
}

export interface AuthorshipData {
  sections: Record<string, SectionAuthorship>;
  stats: { aiPercent: number; humanPercent: number; totalChars: number };
}

const AUTHORSHIP_START = "<!-- TMUX-IDE:AUTHORSHIP";
const AUTHORSHIP_END = "-->";

/**
 * Extract authorship data from a markdown file.
 * Returns clean content (without the comment block) and parsed authorship.
 */
export function extractAuthorship(markdown: string): {
  content: string;
  authorship: AuthorshipData | null;
} {
  const startIdx = markdown.lastIndexOf(AUTHORSHIP_START);
  if (startIdx === -1) {
    return { content: markdown, authorship: null };
  }

  const endIdx = markdown.indexOf(AUTHORSHIP_END, startIdx + AUTHORSHIP_START.length);
  if (endIdx === -1) {
    return { content: markdown, authorship: null };
  }

  const jsonStr = markdown
    .slice(startIdx + AUTHORSHIP_START.length, endIdx)
    .trim();
  const content = (markdown.slice(0, startIdx) + markdown.slice(endIdx + AUTHORSHIP_END.length)).trimEnd();

  try {
    const data = JSON.parse(jsonStr) as AuthorshipData;
    return { content, authorship: data };
  } catch {
    return { content, authorship: null };
  }
}

/**
 * Embed authorship data into a markdown file.
 * Strips any existing authorship comment and appends a new one at the end.
 */
export function embedAuthorship(markdown: string, authorship: AuthorshipData): string {
  // Strip existing authorship comment
  const { content } = extractAuthorship(markdown);
  const json = JSON.stringify(authorship);
  return `${content}\n\n${AUTHORSHIP_START}\n${json}\n${AUTHORSHIP_END}\n`;
}

/**
 * Calculate AI vs human percentages from section authorships.
 */
export function calculateStats(
  sections: Record<string, SectionAuthorship>,
): { aiPercent: number; humanPercent: number; totalChars: number } {
  let aiChars = 0;
  let humanChars = 0;

  for (const section of Object.values(sections)) {
    if (section.author.startsWith("ai:") || section.author === "ai") {
      aiChars += section.charCount;
    } else {
      humanChars += section.charCount;
    }
  }

  const totalChars = aiChars + humanChars;
  if (totalChars === 0) {
    return { aiPercent: 0, humanPercent: 0, totalChars: 0 };
  }

  return {
    aiPercent: Math.round((aiChars / totalChars) * 100),
    humanPercent: Math.round((humanChars / totalChars) * 100),
    totalChars,
  };
}

/**
 * Parse markdown into sections by ## headings.
 * Returns an array of { heading, content, charCount }.
 * Content before the first heading is assigned heading "(intro)".
 */
export function parseMarkdownSections(
  markdown: string,
): { heading: string; content: string; charCount: number }[] {
  const lines = markdown.split("\n");
  const sections: { heading: string; content: string; charCount: number }[] = [];
  let currentHeading = "(intro)";
  let currentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,3}\s+(.+)/);
    if (headingMatch) {
      // Flush previous section
      if (currentLines.length > 0 || currentHeading !== "(intro)") {
        const content = currentLines.join("\n").trim();
        if (content.length > 0) {
          sections.push({
            heading: currentHeading,
            content,
            charCount: content.length,
          });
        }
      }
      currentHeading = headingMatch[1]!.trim();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  // Flush last section
  const content = currentLines.join("\n").trim();
  if (content.length > 0) {
    sections.push({
      heading: currentHeading,
      content,
      charCount: content.length,
    });
  }

  return sections;
}

/**
 * Tag untagged sections with the given author.
 * Preserves existing authorship for previously tagged sections.
 * Recalculates stats and embeds updated authorship.
 */
export function tagAuthorship(markdown: string, author: string): string {
  const { content, authorship } = extractAuthorship(markdown);
  const existingSections = authorship?.sections ?? {};
  const parsed = parseMarkdownSections(content);
  const now = new Date().toISOString();

  const sections: Record<string, SectionAuthorship> = {};

  for (const section of parsed) {
    const existing = existingSections[section.heading];
    if (existing) {
      // Update charCount if content changed, keep author
      sections[section.heading] = {
        ...existing,
        charCount: section.charCount,
      };
    } else {
      // New or untagged section
      sections[section.heading] = {
        author,
        at: now,
        charCount: section.charCount,
      };
    }
  }

  const stats = calculateStats(sections);
  return embedAuthorship(content, { sections, stats });
}

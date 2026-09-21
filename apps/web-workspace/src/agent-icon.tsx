import claudeIcon from "./assets/agents/claudecode.svg?url";
import codexIcon from "./assets/agents/codex.svg?url";
import opencodeIcon from "./assets/agents/opencode.svg?url";
import { Sparkles } from "./icons";
const brands = [
  { match: /claude/i, id: "claudecode", url: claudeIcon, name: "Claude Code" },
  { match: /codex|openai/i, id: "codex", url: codexIcon, name: "Codex" },
  { match: /opencode/i, id: "opencode", url: opencodeIcon, name: "OpenCode" },
];
/** Local Lobe Icons SVG assets (MIT); masks inherit the current theme's ink. */
export function AgentIcon({ name, size = 14 }: { name: string; size?: number }) {
  const brand = brands.find((b) => b.match.test(name));
  if (!brand) return <Sparkles size={size} />;
  return (
    <span
      className="agent-brand-icon"
      data-agent-icon={brand.id}
      aria-hidden="true"
      title={brand.name}
      style={{
        width: size,
        height: size,
        maskImage: `url(${JSON.stringify(brand.url)})`,
        WebkitMaskImage: `url(${JSON.stringify(brand.url)})`,
      }}
    />
  );
}

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  INSTALL_COMMAND,
  PUBLISHER_NAME,
  PUBLISHER_URL,
  SITE_NAME,
  SITE_REPOSITORY,
  absoluteUrl,
} from "@/lib/site";

/** The urn:air publisher segment: the domain that speaks for these resources. */
const PUBLISHER_DOMAIN = "tmux-ide.com";

export const SERVER_CARD_PATH = "/.well-known/mcp/server-card.json";
export const API_CATALOG_PATH = "/.well-known/api-catalog";
export const SKILL_URL = "https://raw.githubusercontent.com/wavyrai/tmux-ide/main/skill/SKILL.md";
export const SKILL_NAME = "tmux-ide";
export const SERVER_CARD_TYPE = "application/mcp-server-card+json";
export const AI_CATALOG_TYPE = "application/ai-catalog+json";
export const LINKSET_TYPE =
  'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"';

/** The committed skill/SKILL.md, read at build time so the digest is always the file's. */
function skillFile(): Buffer {
  return readFileSync(resolve(process.cwd(), "../skill/SKILL.md"));
}

function skillDigest(): string {
  return `sha256:${createHash("sha256").update(skillFile()).digest("hex")}`;
}

/** The skill's frontmatter `description`, so every catalog says what skills.sh says. */
export const SKILL_DESCRIPTION = (() => {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(skillFile().toString("utf8"))?.[1] ?? "";
  const value = /^description:\s*(.+)$/mu.exec(frontmatter)?.[1]?.trim();
  if (!value) throw new Error("skill/SKILL.md has no frontmatter description");
  return value.startsWith('"') ? (JSON.parse(value) as string) : value;
})();

export function jsonResponse(body: unknown, contentType: string, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", contentType);
  return new Response(`${JSON.stringify(body, null, 2)}\n`, { headers });
}

const urn = (namespace: string, name: string) => `urn:air:${PUBLISHER_DOMAIN}:${namespace}:${name}`;

/** The publisher's identity: an HTTPS URI on the urn:air publisher domain, so the two align. */
const PUBLISHER_IDENTITY = `https://${PUBLISHER_DOMAIN}`;

/** Every resource here is built and published from the public GitHub repository. */
const provenance = [{ relation: "publishedFrom", sourceId: SITE_REPOSITORY }];

/**
 * ARD trustManifest (ARD §4.5, ard-entry.schema.json): identity only, no
 * attestations or signature. ARD requires `identity`, an SPIFFE ID, DID or
 * HTTPS URI whose trust domain matches the identifier's publisher segment.
 */
const ardTrustManifest = { identity: PUBLISHER_IDENTITY, identityType: "https", provenance };

/**
 * AI Catalog 1.0 Trust Manifest, unsigned: a contributor plus the provenance
 * link, since the spec rejects a manifest with no trust member besides
 * `contributor` ("Manifest Validity").
 */
const aiCatalogTrustManifest = { contributor: PUBLISHER_IDENTITY, provenance };

const resources = () => [
  {
    identifier: urn("mcp", "automation"),
    displayName: "tmux-ide automation MCP server",
    type: SERVER_CARD_TYPE,
    url: absoluteUrl(SERVER_CARD_PATH),
    description:
      "Local MCP server over stdio (`tmux-ide mcp`): discover tmux panes, then prepare and execute scoped pane reads and sends with retry-safe operation handles.",
    representativeQueries: [
      "list the tmux panes my coding agents are running in",
      "send a message to another agent's tmux pane",
      "read the output of a tmux pane from an MCP client",
    ],
    capabilities: [
      "tmux_panes",
      "tmux_prepare",
      "tmux_execute",
      "tmux_operation_status",
      "tmux_interactions",
    ],
    tags: ["mcp", "tmux", "stdio"],
  },
  {
    identifier: urn("skill", SKILL_NAME),
    displayName: "tmux-ide agent skill",
    type: "application/agent-skills+md",
    url: SKILL_URL,
    description: SKILL_DESCRIPTION,
    representativeQueries: [
      "report my agent status to the tmux status bar",
      "see which coding agents are blocked across tmux sessions",
      "restore my tmux sessions and agent conversations after a crash",
    ],
    tags: ["agent-skill", "tmux"],
    digest: skillDigest(),
  },
  {
    identifier: urn("docs", "agents-md"),
    displayName: "tmux-ide manual for AI agents",
    type: "text/markdown",
    url: absoluteUrl("/agents.md"),
    description:
      "Install, the agent status contract, and the commands agents use to observe and coordinate, in one Markdown page.",
    representativeQueries: [
      "how does an agent report its state to tmux-ide",
      "which tmux-ide commands return JSON for agents",
    ],
    tags: ["documentation", "markdown"],
  },
  {
    identifier: urn("docs", "llms-txt"),
    displayName: "tmux-ide llms.txt",
    type: "text/plain",
    url: absoluteUrl("/llms.txt"),
    description: "Index of the tmux-ide documentation for language models (llmstxt.org).",
    representativeQueries: [
      "find the tmux-ide documentation page for a topic",
      "get the tmux-ide docs as Markdown",
    ],
    tags: ["documentation", "llms.txt"],
  },
];

/** /.well-known/ard.json (Agentic Resource Discovery). ARD defines no `digest` member. */
export function ardManifest() {
  return {
    entries: resources().map(({ digest: _digest, ...entry }) => ({
      ...entry,
      trustManifest: ardTrustManifest,
    })),
  };
}

/** /.well-known/ai-catalog.json (AI Catalog 1.0): same entries, that standard's shape. */
export function aiCatalog() {
  const publisher = { identifier: PUBLISHER_URL, displayName: PUBLISHER_NAME };
  return {
    specVersion: "1.0",
    host: {
      displayName: SITE_NAME,
      identifier: PUBLISHER_DOMAIN,
      documentationUrl: absoluteUrl("/docs"),
      logoUrl: absoluteUrl("/icon.png"),
    },
    // displayName and representativeQueries stay on every entry: ARD consumers read
    // ai-catalog.json as an entry source and require them (PM decision, 29 Oct).
    // For the same readers each entry carries ARD's trustManifest beside AI
    // Catalog's own trustManifests.
    entries: resources().map(({ capabilities: _caps, ...entry }) => ({
      ...entry,
      publisher,
      trustManifest: ardTrustManifest,
      trustManifests: [aiCatalogTrustManifest],
    })),
  };
}

/**
 * The MCP server card (server-card extension, v1 schema). Tools are not a card
 * member; the stdio launch command and the tool names sit under `_meta`, and
 * check-agent-discovery.mjs fails if the names differ from mcp.ts's registerTool calls.
 */
export function serverCard() {
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: "com.tmux-ide/automation",
    version: "1.0.0",
    title: "tmux-ide automation",
    description:
      "Scoped tmux pane discovery, reads and sends with retry-safe handles, over local stdio.",
    icons: [{ src: absoluteUrl("/icon.png"), mimeType: "image/png", sizes: ["256x256"] }],
    websiteUrl: absoluteUrl("/docs/automation"),
    repository: { url: SITE_REPOSITORY, source: "github" },
    _meta: {
      "com.tmux-ide/stdio": {
        transport: "stdio",
        command: "tmux-ide",
        args: ["mcp"],
        install: INSTALL_COMMAND,
        installAlternative: "npm install -g tmux-ide",
      },
      "com.tmux-ide/tools": [
        "tmux_panes",
        "tmux_prepare",
        "tmux_execute",
        "tmux_operation_status",
        "tmux_interactions",
      ],
    },
  };
}

/** /.well-known/api-catalog (RFC 9727): the automation interface and its docs. No OpenAPI exists. */
export function apiCatalog() {
  const automation = absoluteUrl("/docs/automation");
  return {
    linkset: [
      {
        anchor: absoluteUrl(API_CATALOG_PATH),
        item: [
          {
            href: automation,
            title: "tmux-ide automation: scoped pane reads and sends (CLI and MCP over stdio)",
            type: "text/html",
          },
        ],
      },
      {
        anchor: automation,
        "service-doc": [
          { href: automation, type: "text/html" },
          { href: absoluteUrl("/docs/automation.md"), type: "text/markdown" },
          { href: absoluteUrl("/docs"), type: "text/html" },
          { href: absoluteUrl("/llms.txt"), type: "text/plain" },
        ],
      },
    ],
  };
}

/** /.well-known/agent-skills/index.json (Agent Skills discovery v0.2.0). */
export function agentSkillsIndex() {
  return {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: SKILL_NAME,
        type: "skill-md",
        description: SKILL_DESCRIPTION,
        url: SKILL_URL,
        digest: skillDigest(),
      },
    ],
  };
}

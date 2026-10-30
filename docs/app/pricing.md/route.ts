import {
  INSTALL_COMMAND,
  SITE_NAME,
  SITE_REPOSITORY,
  SOFTWARE_DOWNLOAD_URL,
  SOFTWARE_VERSION,
} from "@/lib/site";

export const revalidate = false;

const LICENSE_URL = `${SITE_REPOSITORY}/blob/main/LICENSE`;

/** Machine-readable pricing for agents comparing tools: there is one plan, and it is free. */
const pricing = `# ${SITE_NAME} pricing

${SITE_NAME} is free and open source software under the MIT license. There are no paid tiers, no accounts, no usage limits and nothing to buy.

## Plans

| Plan | Price | Limits |
| --- | --- | --- |
| Open source (MIT) | Free | None |

The free plan is the whole product: the terminal app, the CLI and the local MCP server, version ${SOFTWARE_VERSION}. There is no paid edition and no trial.

## Install

\`\`\`bash
${INSTALL_COMMAND}
\`\`\`

The same CLI is published on npm: ${SOFTWARE_DOWNLOAD_URL}

## License and source

- License: MIT, ${LICENSE_URL}
- Source code: ${SITE_REPOSITORY}

## Costs outside ${SITE_NAME}

${SITE_NAME} runs on your own machines and has no hosted service. Coding agents you run inside it, such as Claude Code or Codex, bill through their own providers under their own plans.
`;

export function GET() {
  return new Response(pricing, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

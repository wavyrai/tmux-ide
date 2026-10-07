// Permanent redirects for docs URLs that search engines indexed before the
// pages were retired. next.config.mjs serves them; check:seo verifies every
// destination is a built page and no source shadows one. When a docs page is
// removed or renamed, add its old path here.

const CURRENT_RELEASE = "/docs/release-2-9-4";
// Missions, tasks and validation contracts never shipped; agent coordination
// (send, wait, team groups, Claude Code agent teams) is the closest real page.
const AGENT_COORDINATION = "/docs/multi-agent-teams";

/** @type {Record<string, string>} old path → current path */
export const LEGACY_REDIRECTS = {
  "/docs/agent-teams": "/docs/multi-agent-teams",
  "/docs/dashboard": "/docs/app-surfaces",
  "/docs/programmatic": "/docs/automation",
  "/docs/task-system": AGENT_COORDINATION,
  "/docs/missions-workflow": AGENT_COORDINATION,
  "/docs/validation-contracts": AGENT_COORDINATION,
  "/docs/knowledge-library": AGENT_COORDINATION,
  "/docs/tips": AGENT_COORDINATION,
  "/docs/release-1-1-0": CURRENT_RELEASE,
  "/docs/release-1-2-0": CURRENT_RELEASE,
  "/docs/release-1-3-0": CURRENT_RELEASE,
  "/docs/release-2-0-0": CURRENT_RELEASE,
  "/docs/release-2-5-0": CURRENT_RELEASE,
  "/docs/release-2-6-0": CURRENT_RELEASE,
  "/docs/release-2-7-0": CURRENT_RELEASE,
  "/docs/release-2-8-0": CURRENT_RELEASE,
};

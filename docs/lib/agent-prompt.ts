/**
 * The one-line setup prompt shown and copied by CopyAgentPrompt. It is the
 * only copy of the text, so what people read and what lands on their
 * clipboard can never drift. It points at production on purpose: an agent
 * should read the published manual, not a preview deployment.
 */
export const AGENT_PROMPT =
  "Read https://tmux-ide.com/agents.md, set up tmux-ide for this project, and tell me what you did.";

import packageMetadata from "../../package.json";

const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();

export const SITE_URL = (configuredUrl || "https://tmux.thijsverreck.com").replace(/\/+$/u, "");
export const SITE_NAME = "tmux-ide";
export const SITE_TITLE = "tmux-ide — a dedicated workspace for coding agents";
export const SITE_DESCRIPTION =
  "Build and coordinate coding agents in one agent-aware tmux workspace with memorable names, live status, exact pane navigation, durable sessions, and SSH support.";
export const SITE_IMAGE = "/og-image.png";
export const SITE_REPOSITORY = "https://github.com/wavyrai/tmux-ide";
export const SOFTWARE_DOWNLOAD_URL = "https://www.npmjs.com/package/tmux-ide";
export const SOFTWARE_VERSION = packageMetadata.version;
export const SOCIAL_PROFILE = "https://x.com/prototyper_co";
export const INSTALL_COMMAND = "npm install -g tmux-ide@beta";
export const APP_COMMAND = "tmux-ide app";
export const CURRENT_RELEASE_PATH = "/docs/release-2-9-0-beta-1";

export function absoluteUrl(path = "/"): string {
  return new URL(path, `${SITE_URL}/`).toString();
}

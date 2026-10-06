import packageMetadata from "../../package.json";

const configuredUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();

export const SITE_URL = (configuredUrl || "https://tmux-ide.com").replace(/\/+$/u, "");
export const SITE_NAME = "tmux-ide";
export const SITE_TAGLINE = "The open-source workspace for coding agents.";
export const SITE_TITLE = "tmux-ide — the open-source workspace for coding agents";
export const SITE_DESCRIPTION =
  "Give coding agents a dedicated tmux workspace with named agents, live status, exact pane navigation, terminal-native controls, durable sessions, and SSH support.";
export const SITE_IMAGE = "/og-image.png";
export const SITE_REPOSITORY = "https://github.com/wavyrai/tmux-ide";
export const SOFTWARE_DOWNLOAD_URL = "https://www.npmjs.com/package/tmux-ide";
export const SOFTWARE_VERSION = packageMetadata.version;
export const SOFTWARE_LICENSE = "https://spdx.org/licenses/MIT.html";
export const PUBLISHER_NAME = "Prototyper";
export const PUBLISHER_URL = "https://www.prototyper.co";
/** Prototyper's own entity id, so both sites describe one organization. */
export const PUBLISHER_ID = `${PUBLISHER_URL}/#organization`;
export const INSTALL_COMMAND = "curl -fsSL https://tmux-ide.com/install.sh | sh";
export const APP_COMMAND = "tmux-ide app";
export const CURRENT_RELEASE_PATH = "/docs/release-2-9-3";

export function absoluteUrl(path = "/"): string {
  return new URL(path, `${SITE_URL}/`).toString();
}

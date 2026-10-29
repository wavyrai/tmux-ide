import type { Metadata } from "next";

import { TrustLink, TrustPage, TrustSection } from "@/components/trust/trust-page";
import {
  CURRENT_RELEASE_PATH,
  INSTALL_COMMAND,
  PUBLISHER_NAME,
  PUBLISHER_URL,
  SITE_REPOSITORY,
  SOFTWARE_DOWNLOAD_URL,
  SOFTWARE_VERSION,
} from "@/lib/site";

export const metadata: Metadata = {
  title: "About tmux-ide",
  description:
    "What tmux-ide is, who builds it, its MIT license and source code, and how each release reaches npm and the tmux-ide.com installer.",
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <TrustPage
      eyebrow="About"
      title="About tmux-ide"
      lede="tmux-ide is an open-source workspace for coding agents, built on tmux. Prototyper publishes it under the MIT license."
    >
      <TrustSection title="What it is">
        <p>
          tmux-ide runs coding agents, such as Claude Code and Codex, in the tmux sessions you
          already use. It shows what every agent is doing (working, blocked, done or idle) and lets
          you jump to the pane that needs you. tmux keeps owning every process and pane, so closing
          tmux-ide never stops an agent.
        </p>
        <p>
          It runs on macOS on Apple Silicon and on glibc Linux, including WSL on Windows.{" "}
          <TrustLink href="/docs/getting-started">Getting started</TrustLink> lists the
          requirements, and the <TrustLink href="/docs">documentation</TrustLink> covers every
          command and setting.
        </p>
      </TrustSection>

      <TrustSection title="Who builds it">
        <p>
          tmux-ide is a project of <TrustLink href={PUBLISHER_URL}>{PUBLISHER_NAME}</TrustLink>.
          Thijs Verreck holds the copyright and maintains the project. Contributions come in as pull
          requests on GitHub; <TrustLink href="/docs/contributing">Contributing</TrustLink> explains
          how to build and test a change.
        </p>
      </TrustSection>

      <TrustSection title="License and source code">
        <p>
          The code is open source under the{" "}
          <TrustLink href={`${SITE_REPOSITORY}/blob/main/LICENSE`}>MIT license</TrustLink>. The
          whole project lives in one repository,{" "}
          <TrustLink href={SITE_REPOSITORY}>wavyrai/tmux-ide</TrustLink> on GitHub: the CLI, the
          terminal app, the daemon, the installer and this website.
        </p>
      </TrustSection>

      <TrustSection title="How releases ship">
        <p>
          Each release starts with a version tag in the repository. GitHub Actions then builds the
          app binaries for each platform, attaches them to a GitHub release, and publishes the{" "}
          <TrustLink href={SOFTWARE_DOWNLOAD_URL}>tmux-ide package on npm</TrustLink> with signed
          npm provenance. The current version is {SOFTWARE_VERSION}.
        </p>
        <p>
          You can install a release two ways. <code>npm install -g tmux-ide</code> installs the
          package with your own Node.js. <code>{INSTALL_COMMAND}</code> runs the installer that this
          site serves: it downloads an official Node.js runtime, checks its SHA-256 sum, and then
          installs the same npm package into your home directory, with no sudo.
        </p>
        <p>
          The <TrustLink href={`${SITE_REPOSITORY}/blob/main/CHANGELOG.md`}>changelog</TrustLink>{" "}
          lists the changes in every version, and the{" "}
          <TrustLink href={CURRENT_RELEASE_PATH}>release notes</TrustLink> describe the current
          release line.
        </p>
      </TrustSection>

      <TrustSection title="This website">
        <p>
          tmux-ide.com hosts the documentation, the installer script, and files for agents such as{" "}
          <TrustLink href="/llms.txt">llms.txt</TrustLink>. It is built with Next.js, served by
          Vercel, and its source is in the <code>docs/</code> folder of the same repository. To
          report a problem or ask a question, see <TrustLink href="/contact">Contact</TrustLink>.
          What the site and the software collect is on the{" "}
          <TrustLink href="/privacy">Privacy</TrustLink> page.
        </p>
      </TrustSection>
    </TrustPage>
  );
}

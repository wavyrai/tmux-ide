import type { Metadata } from "next";

import { TrustLink, TrustPage, TrustSection } from "@/components/trust/trust-page";
import { SITE_REPOSITORY } from "@/lib/site";

export const metadata: Metadata = {
  title: "Contact",
  description:
    "How to report a bug, ask a question or send a security report about tmux-ide: GitHub issues for support, GitHub Security Advisories for security.",
  alternates: { canonical: "/contact" },
};

const NEW_ISSUE_URL = `${SITE_REPOSITORY}/issues/new/choose`;
const ISSUES_URL = `${SITE_REPOSITORY}/issues`;
const ADVISORIES_URL = `${SITE_REPOSITORY}/security/advisories`;
const SECURITY_POLICY_URL = `${SITE_REPOSITORY}/security/policy`;

export default function ContactPage() {
  return (
    <TrustPage
      eyebrow="Contact"
      title="Contact"
      lede="All contact about tmux-ide goes through its GitHub repository. Bugs and questions go in a public issue; security reports go in private."
    >
      <TrustSection title="Bugs and help">
        <p>
          To report a bug or ask for help, <TrustLink href={NEW_ISSUE_URL}>open an issue</TrustLink>{" "}
          and pick the bug report or feature request form. You need a GitHub account. Search the{" "}
          <TrustLink href={ISSUES_URL}>existing issues</TrustLink> first: someone may have hit the
          same problem.
        </p>
        <p>A bug report is quickest to act on when it includes:</p>
        <ul>
          <li>
            the output of <code>tmux-ide --version</code> and <code>tmux-ide doctor</code>;
          </li>
          <li>your operating system, terminal and shell;</li>
          <li>the steps that reproduce the problem, and what you expected instead.</li>
        </ul>
        <p>
          Before you file, <TrustLink href="/docs/troubleshooting">Troubleshooting</TrustLink>{" "}
          covers the common install and session problems.
        </p>
      </TrustSection>

      <TrustSection title="Questions and ideas">
        <p>
          The repository has no discussion forum, so questions and ideas go in an issue too. The bug
          report form fits a question about something that doesn&apos;t work as you expect. The
          feature request form fits an idea or a missing workflow.
        </p>
      </TrustSection>

      <TrustSection title="Security reports">
        <p>
          Don&apos;t open a public issue for a security problem. Report it privately through{" "}
          <TrustLink href={ADVISORIES_URL}>GitHub Security Advisories</TrustLink> for the
          repository, as the <TrustLink href={SECURITY_POLICY_URL}>security policy</TrustLink> says.
          Include the affected version, your operating system and shell, the steps to reproduce, the
          impact, and any fix you propose.
        </p>
        <p>
          If you can&apos;t file a private advisory, use the private contact method on the
          maintainer&apos;s GitHub or npm profile. If neither works, open a short issue that asks
          for a private channel, with no details of the problem in it.
        </p>
      </TrustSection>

      <TrustSection title="Contributing">
        <p>
          To fix something yourself, send a pull request.{" "}
          <TrustLink href="/docs/contributing">Contributing</TrustLink> covers the local setup, the
          tests and what a pull request needs.
        </p>
      </TrustSection>
    </TrustPage>
  );
}

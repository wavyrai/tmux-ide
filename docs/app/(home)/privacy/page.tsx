import type { Metadata } from "next";

import { TrustLink, TrustPage, TrustSection } from "@/components/trust/trust-page";
import { SITE_REPOSITORY } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy",
  description:
    "What tmux-ide.com and the tmux-ide software collect: no cookies, cookieless Vercel Web Analytics page views, and a daily npm version check.",
  alternates: { canonical: "/privacy" },
};

const VERCEL_ANALYTICS_PRIVACY = "https://vercel.com/docs/analytics/privacy-policy";
const source = (path: string) => `${SITE_REPOSITORY}/blob/main/${path}`;

export default function PrivacyPage() {
  return (
    <TrustPage
      eyebrow="Privacy"
      title="Privacy"
      lede="tmux-ide.com sets no cookies and loads nothing from other sites. It counts page views with Vercel Web Analytics. The tmux-ide software checks npm once a day for a newer version, and you can turn that off."
      updated={{ iso: "2026-10-29", label: "29 October 2026" }}
    >
      <TrustSection title="What this website collects">
        <p>
          We measured these facts on the live site in a real browser on 29 October 2026, on the
          homepage and the documentation, including a click and a search.
        </p>
        <ul>
          <li>
            Every request the page made went to tmux-ide.com. The site loads no scripts, fonts or
            images from other sites.
          </li>
          <li>The site sets no cookies, before or after you click a link or search.</li>
          <li>
            The site stores nothing in your browser&apos;s local storage, with one exception: if you
            use the theme switch, the key <code>theme</code> remembers light or dark. It stays in
            your browser.
          </li>
          <li>
            Documentation search sends the text you type, and nothing else from the page, as{" "}
            <code>/api/search?query=…</code> to tmux-ide.com.
          </li>
        </ul>
      </TrustSection>

      <TrustSection title="Page view counts">
        <p>
          The site uses <TrustLink href={VERCEL_ANALYTICS_PRIVACY}>Vercel Web Analytics</TrustLink>{" "}
          to count page views. For each page you open, the script sends one request to tmux-ide.com
          with the page address, the page&apos;s route pattern (such as <code>/docs/[...slug]</code>
          ), the address of the site that linked you here, and the script&apos;s version. It sends
          no cookie and stores nothing in your browser.
        </p>
        <p>
          According to Vercel&apos;s documentation, Vercel also records the location (country,
          region and city), the operating system, the browser and the device type. It identifies a
          visit by a hash of the request rather than a cookie, discards that hash after 24 hours,
          and gives us aggregated counts only.
        </p>
      </TrustSection>

      <TrustSection title="Hosting and the installer">
        <p>
          Vercel hosts tmux-ide.com. As with any website, your browser&apos;s requests reach
          Vercel&apos;s servers with your IP address and the headers your browser sends. When you
          follow a link to another site, the site&apos;s referrer policy lets your browser send only{" "}
          <code>https://tmux-ide.com/</code>, not the page you were on.
        </p>
        <p>
          <code>curl -fsSL https://tmux-ide.com/install.sh | sh</code> fetches the installer with an
          ordinary request, the same as a page, and sets no cookie. The installer then downloads
          Node.js from nodejs.org and the tmux-ide package from the npm registry. When it installs
          the macOS native alpha, it also downloads a release file from GitHub.
        </p>
      </TrustSection>

      <TrustSection title="What the tmux-ide software sends">
        <p>
          This section covers the tmux-ide CLI and terminal app that npm and the installer set up.
          They contain no analytics or telemetry code, and make only these requests to the internet:
        </p>
        <ul>
          <li>
            Once a day, a version check asks the npm registry for the latest version (
            <code>registry.npmjs.org/tmux-ide/latest</code>, or <code>beta</code> on a beta
            release). The request carries no data about you or your sessions. To turn it off, set{" "}
            <code>
              &quot;updates&quot;: {"{"} &quot;check&quot;: false {"}"}
            </code>{" "}
            in <code>~/.tmux-ide/config.json</code> (
            <TrustLink href={source("packages/daemon/src/lib/update-check.ts")}>
              update-check.ts
            </TrustLink>
            ).
          </li>
          <li>
            If you set <code>updates.manifests</code> to <code>true</code> (off by default), the
            same daily check downloads the agent-detection manifest pack from the tmux-ide GitHub
            releases (
            <TrustLink href={source("packages/daemon/src/lib/manifest-pack.ts")}>
              manifest-pack.ts
            </TrustLink>
            ).
          </li>
          <li>
            When you run <code>tmux-ide update</code>, it fetches the new release through npm or the
            tmux-ide.com installer. <code>tmux-ide update --tui-binary</code> downloads the app
            binary from the tmux-ide GitHub releases.
          </li>
        </ul>
        <p>
          Agent status, sessions and restore snapshots stay on your machine and on the SSH hosts you
          connect. Programs you run inside tmux-ide, such as coding agents, make their own network
          connections under their own terms. The macOS native alpha is a separate build that this
          page does not yet describe.
        </p>
      </TrustSection>

      <TrustSection title="Questions">
        <p>
          For a question about this page, see <TrustLink href="/contact">Contact</TrustLink>. If
          this page changes, its date above changes too, and the history is in the{" "}
          <TrustLink href={source("docs/app/(home)/privacy/page.tsx")}>repository</TrustLink>.
        </p>
      </TrustSection>
    </TrustPage>
  );
}

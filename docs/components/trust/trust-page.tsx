import Link from "next/link";
import type { ReactNode } from "react";

import { Band, BandBody, MarketingFrame, Stretch } from "@/components/marketing/lattice";

/** One text column for the About, Contact and Privacy pages. */
export function TrustPage({
  eyebrow,
  title,
  lede,
  updated,
  children,
}: {
  eyebrow: string;
  title: string;
  lede: ReactNode;
  /** Shown as "Last updated", for pages whose statements are dated. */
  updated?: { iso: string; label: string };
  children: ReactNode;
}) {
  return (
    <MarketingFrame id="main-content" tabIndex={-1}>
      <Stretch ground="paper">
        <Band rule={false}>
          <BandBody className="pt-12! md:pt-16!">
            <article className="mx-auto max-w-[44rem]">
              <header>
                <p className="type-subheadline text-fd-muted-foreground">{eyebrow}</p>
                <h1 className="type-display-4 lg:type-display-3 mt-3 text-fd-foreground">
                  {title}
                </h1>
                <p className="type-marketing-lede mt-5 text-fd-muted-foreground">{lede}</p>
                {updated ? (
                  <p className="type-caption-1 mt-4 text-fd-muted-foreground">
                    Last updated <time dateTime={updated.iso}>{updated.label}</time>
                  </p>
                ) : null}
              </header>
              <div className="mt-12 space-y-12">{children}</div>
            </article>
          </BandBody>
        </Band>
      </Stretch>
    </MarketingFrame>
  );
}

export function TrustSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="type-title-2 text-fd-foreground">{title}</h2>
      <div className="type-marketing-body mt-4 space-y-4 text-fd-muted-foreground [&_code]:font-mono [&_code]:text-fd-foreground [&_li]:ml-5 [&_li]:list-disc [&_li]:pl-1 [&_ul]:space-y-2">
        {children}
      </div>
    </section>
  );
}

/** A link inside page copy; off-site targets get `rel="noreferrer"`. */
export function TrustLink({ href, children }: { href: string; children: ReactNode }) {
  const external = /^https?:\/\//u.test(href);
  return (
    <Link
      href={href}
      className="marketing-link-action text-fd-primary underline decoration-fd-border underline-offset-4"
      {...(external ? { rel: "noreferrer" } : {})}
    >
      {children}
    </Link>
  );
}

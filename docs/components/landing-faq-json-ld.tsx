import { LANDING_FAQ } from "@/lib/landing-content";
import { SITE_URL } from "@/lib/site";

const landingFaqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "@id": `${SITE_URL}/#faq`,
  url: `${SITE_URL}/#faq`,
  inLanguage: "en",
  mainEntity: LANDING_FAQ.map(({ question, answer }) => ({
    "@type": "Question",
    name: question,
    acceptedAnswer: { "@type": "Answer", text: answer },
  })),
};

/** Homepage-only schema, sourced from the exact data rendered by the visible FAQ. */
export function LandingFaqJsonLd() {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(landingFaqJsonLd).replace(/</gu, "\\u003c"),
      }}
    />
  );
}

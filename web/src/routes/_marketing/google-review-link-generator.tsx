import { createFileRoute } from "@tanstack/react-router";
import { GoogleBusinessLinkTool } from "@/components/google-business-link-tool";
import { ToolFrame } from "@/lib/free-tools/tool-frame";
import { freeTools } from "@/lib/free-tools/tool-pages";
import { buildPageSeo } from "@/lib/seo";

const TOOL = freeTools["google-review-link-generator"];

export const Route = createFileRoute(
  "/_marketing/google-review-link-generator",
)({
  head: () =>
    buildPageSeo({
      title: "Free Google Review Link Generator",
      description:
        "Create a direct Google review link from a Place ID or Maps URL. Paste, copy, and share — parsing stays in your browser. No signup.",
      path: TOOL.path,
      titleSuffix: "OpenSEO",
      imageAlt: "OpenSEO Google review link generator",
    }),
  component: GoogleReviewLinkPage,
});

const FAQS = [
  {
    question: "What is a Google review link?",
    answer:
      "It is a URL that opens the Google review form for a specific business. Customers can leave a rating without hunting for your listing in Maps.",
  },
  {
    question: "Why do I need a Place ID?",
    answer:
      "Google review URLs use a Place ID (usually starting with ChIJ). If you only have a numeric CID, use our CID converter or paste a full Maps place link that includes the Place ID.",
  },
  {
    question: "Does this tool send my data anywhere?",
    answer:
      "No. Your input is parsed locally in the browser. OpenSEO does not store Maps URLs or Place IDs for this tool.",
  },
];

const HIGHLIGHTS = [
  {
    title: "Agency-friendly",
    description:
      "Paste a client Maps URL once and copy a review link for email, SMS, or QR codes.",
  },
  {
    title: "Works with Place ID or URL",
    description:
      "Accepts ChIJ ids, writereview links, and standard Google Maps place URLs.",
  },
  {
    title: "No API usage",
    description:
      "Unlike data-heavy SEO tools, this utility does not call external APIs or Turnstile.",
  },
];

function GoogleReviewLinkPage() {
  return (
    <ToolFrame
      tool={TOOL}
      heading="Google Review Link Generator"
      subhead="Turn a Place ID or Google Maps URL into a shareable review link. Everything stays in your browser."
      highlights={HIGHLIGHTS}
      faqs={FAQS}
      cta={{
        heading: "Track local visibility in one workspace",
        body: "OpenSEO includes local SEO research and rank tracking with trial credits when you need more than quick link tools.",
        featureLabel: "See features",
      }}
    >
      <GoogleBusinessLinkTool
        mode="review"
        toolSlug="google-review-link-generator"
      />
    </ToolFrame>
  );
}

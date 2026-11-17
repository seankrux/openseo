import { createFileRoute } from "@tanstack/react-router";
import { GoogleBusinessLinkTool } from "@/components/google-business-link-tool";
import { ToolFrame } from "@/lib/free-tools/tool-frame";
import { freeTools } from "@/lib/free-tools/tool-pages";
import { buildPageSeo } from "@/lib/seo";

const TOOL = freeTools["google-cid-converter"];

export const Route = createFileRoute("/_marketing/google-cid-converter")({
  head: () =>
    buildPageSeo({
      title: "Free Google CID Converter",
      description:
        "Convert a Google Business CID or Maps URL into shareable Maps links. See Place ID when it is in the URL. No signup, no API calls.",
      path: TOOL.path,
      titleSuffix: "OpenSEO",
      imageAlt: "OpenSEO Google CID converter",
    }),
  component: GoogleCidConverterPage,
});

const FAQS = [
  {
    question: "What is a Google CID?",
    answer:
      "CID is a numeric identifier Google uses in some Maps URLs (the cid= parameter). It is not the same as a Place ID, but both can open a business in Maps.",
  },
  {
    question: "Can this convert CID to Place ID?",
    answer:
      "Only when the Place ID is already present in the URL or text you paste. Resolving CID to Place ID without that requires Google’s APIs; we do not call them in this free tool.",
  },
  {
    question: "Is my input stored?",
    answer:
      "No. Parsing happens entirely in your browser.",
  },
];

const HIGHLIGHTS = [
  {
    title: "Copy-ready Maps links",
    description:
      "Get CID-based and Place ID-based Maps URLs when the input supports them.",
  },
  {
    title: "Paste messy URLs",
    description:
      "Full share links, short links, and raw numeric CIDs are supported where possible.",
  },
  {
    title: "Pairs with review links",
    description:
      "Once you have a Place ID, use the review link generator for customer-facing URLs.",
  },
];

function GoogleCidConverterPage() {
  return (
    <ToolFrame
      tool={TOOL}
      heading="Google CID Converter"
      subhead="Extract CID and Place ID from Maps input and copy the Maps links you need."
      highlights={HIGHLIGHTS}
      faqs={FAQS}
      cta={{
        heading: "Go beyond link utilities",
        body: "Use OpenSEO for keyword research, audits, and reporting across many locations.",
        featureLabel: "See features",
      }}
    >
      <GoogleBusinessLinkTool mode="cid" toolSlug="google-cid-converter" />
    </ToolFrame>
  );
}

export type Step = { step: string; status: string; detail?: string };
const STATUS_LABELS: Record<string, string> = {
  pending: "Not started",
  preview: "Previewed",
  created: "Property created",
  tagged: "Tag installed, not yet live",
  live: "Tag live",
  linked: "Linked",
  blocked: "Blocked",
  waiting: "Waiting for reconnect",
  error: "Error",
};
export const statusLabel = (status: string) => STATUS_LABELS[status] ?? status;
export const ATTENTION = new Set(["error", "blocked", "waiting"]);
export type Result = {
  domain: string;
  final: string;
  steps: Step[];
  measurementId?: string;
};
export const PAGE_SIZE = 50;
export const confirmApply = (what: string) =>
  window.confirm(
    `Apply GA4 setup for ${what}? This creates GA4 properties, installs the tag through Cloudflare and links them.`,
  );

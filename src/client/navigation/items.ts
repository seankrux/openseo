import {
  Bookmark,
  Bot,
  Brain,
  ChartLine,
  ChartPie,
  ClipboardCheck,
  FileSpreadsheet,
  FileText,
  Globe,
  HeartPulse,
  KeyRound,
  LayoutList,
  LayoutDashboard,
  Link2,
  MessageSquare,
  Search,
  TrendingUp,
} from "lucide-react";
import { linkOptions } from "@tanstack/react-router";
import { GoogleGlyphMuted } from "@/client/features/gsc/GoogleGlyph";
import {
  fleetChartsLabel,
  fleetSiteTableLabel,
} from "@/client/navigation/fleetNav";

const projectNavItems = [
  {
    to: "/p/$projectId" as const,
    label: "Dashboard",
    icon: LayoutDashboard,
    // Without exact matching, the index path is a prefix of every project
    // route and the Dashboard item would render active everywhere.
    activeOptions: { exact: true, includeSearch: false },
  },
  {
    to: "/p/$projectId/keywords" as const,
    label: "Keyword Research",
    icon: Search,
  },
  {
    to: "/p/$projectId/saved" as const,
    label: "Saved Keywords",
    icon: Bookmark,
  },
  {
    to: "/p/$projectId/rank-tracking" as const,
    label: "Rank Tracking",
    icon: TrendingUp,
  },
  {
    to: "/p/$projectId/search-performance" as const,
    label: "GSC Insights",
    icon: GoogleGlyphMuted,
  },
  {
    to: "/p/$projectId/domain" as const,
    label: "Domain Overview",
    icon: Globe,
  },
  {
    to: "/p/$projectId/backlinks" as const,
    label: "Backlinks",
    icon: Link2,
  },
  {
    to: "/p/$projectId/audit" as const,
    label: "Site Audit",
    icon: ClipboardCheck,
  },
  {
    to: "/p/$projectId/ai-visibility" as const,
    label: "Prompt Tracking",
    icon: ChartLine,
    activeOptions: { exact: true, includeSearch: false },
  },
  {
    to: "/p/$projectId/ai-visibility/research" as const,
    label: "Prompt Research",
    icon: Search,
  },
  {
    to: "/p/$projectId/prompt-explorer" as const,
    label: "Prompt Explorer",
    icon: MessageSquare,
  },
  {
    to: "/p/$projectId/reports" as const,
    label: "Reports",
    icon: FileText,
  },
  {
    to: "/p/$projectId/context" as const,
    label: "Context",
    icon: Brain,
  },
] as const;

// CityThrive fork: fleet-wide shortcuts, pinned at the top of the sidebar
// whether or not a project is selected.
export const allSitesNavGroup = {
  label: "All sites",
  items: linkOptions([
    { to: "/overview" as const, label: fleetSiteTableLabel, icon: LayoutList },
    { to: "/dashboard" as const, label: fleetChartsLabel, icon: ChartPie },
    { to: "/domain-health" as const, label: "Domain health", icon: HeartPulse },
    {
      to: "/ga4-setup" as const,
      search: { projectId: undefined },
      label: "GA4 setup status",
      icon: ChartLine,
    },
    {
      to: "/all-reports" as const,
      label: "Reports and CSV export",
      icon: FileSpreadsheet,
    },
  ]),
};

// Project-independent. Rendered inside the project "Reports & setup" group when a project
// is selected, and on its own (connectNavGroup) when none is.
const aiNavItem = linkOptions({
  to: "/ai" as const,
  label: "Agent setup",
  icon: Bot,
});

// Shown only when no project is selected; with a project, Agent setup lives in
// the "Reports & setup" group below.
export const connectNavGroup = {
  label: "Setup",
  items: [aiNavItem],
};

function getProjectNavItems(projectId: string) {
  return linkOptions(
    projectNavItems.map((item) => ({
      ...item,
      params: { projectId },
      search: {},
    })),
  );
}

// CityThrive fork: on an install without a DataForSEO key, the paid research
// tools cannot return anything. One row in "Reports & setup" keeps them
// discoverable instead of eight dead links.
const dataforseoNavItem = linkOptions({
  to: "/help/dataforseo-api-key" as const,
  label: "More tools need DataForSEO",
  icon: KeyRound,
});

// Grouped by scope: "My Site" is the project's own domain (tracked data),
// "Research" is point-at-anything lookup tools.
export function getProjectNavGroups(
  projectId: string,
  options: {
    /** `false` hides DataForSEO-backed tools; `null` means not known yet. */
    dataforseoConfigured?: boolean | null;
  } = {},
) {
  const all = getProjectNavItems(projectId);
  const byPath = (path: (typeof projectNavItems)[number]["to"]) =>
    all.find((i) => i.to === path)!;
  const measured = options.dataforseoConfigured !== false;

  return [
    {
      label: "This project",
      items: [byPath("/p/$projectId")],
    },
    ...(measured
      ? [
          {
            label: "Research",
            items: [
              byPath("/p/$projectId/keywords"),
              byPath("/p/$projectId/domain"),
              byPath("/p/$projectId/backlinks"),
            ],
          },
          {
            label: "AI Visibility",
            items: [
              byPath("/p/$projectId/ai-visibility"),
              byPath("/p/$projectId/ai-visibility/research"),
              byPath("/p/$projectId/prompt-explorer"),
            ],
          },
        ]
      : []),
    {
      label: "My Site",
      items: [
        byPath("/p/$projectId/search-performance"),
        byPath("/p/$projectId/rank-tracking"),
        ...(measured ? [byPath("/p/$projectId/saved")] : []),
        byPath("/p/$projectId/audit"),
      ],
    },
    {
      label: "Reports & setup",
      items: [
        byPath("/p/$projectId/reports"),
        byPath("/p/$projectId/context"),
        aiNavItem,
        ...(measured ? [] : [dataforseoNavItem]),
      ],
    },
  ];
}

export const dataforseoHelpLinkOptions = linkOptions({
  to: "/help/dataforseo-api-key",
});

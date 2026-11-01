import type { ProjectSummary } from "@/client/features/projects/types";

export function projectSwitcherDisplay(project: ProjectSummary | null): {
  primary: string;
  secondary: string | null;
} {
  if (!project) {
    return { primary: "Select project", secondary: null };
  }
  const name = project.name.trim();
  const domain = project.domain?.trim() ?? null;
  if (
    domain &&
    name.localeCompare(domain, undefined, { sensitivity: "accent" }) === 0
  ) {
    return { primary: domain, secondary: null };
  }
  return { primary: name || domain || "Untitled project", secondary: domain };
}

// CityThrive fork: switch between the all-sites dashboard and the selected
// project's own dashboard.
import { Link } from "@tanstack/react-router";
import { cn } from "cn";

const tab =
  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors text-muted-foreground hover:text-foreground";
const active = "bg-background text-foreground shadow-sm";

export function DashboardScopeTabs({
  current,
  projectId,
  projectLabel,
}: {
  current: "fleet" | "project";
  projectId: string | null;
  projectLabel?: string | null;
}) {
  return (
    <nav
      aria-label="Dashboard scope"
      className="inline-flex w-fit max-w-full items-center gap-1 rounded-lg border border-border bg-muted/50 p-1"
    >
      <Link
        to="/dashboard"
        className={cn(
          tab,
          "shrink-0 whitespace-nowrap",
          current === "fleet" && active,
        )}
      >
        All sites
      </Link>
      {projectId ? (
        <Link
          to="/p/$projectId"
          params={{ projectId }}
          search={{}}
          className={cn(
            tab,
            current === "project" && active,
            "min-w-0 max-w-64 truncate",
          )}
          title={projectLabel ? `Project: ${projectLabel}` : "This project"}
        >
          {projectLabel ? `Project: ${projectLabel}` : "This project"}
        </Link>
      ) : null}
    </nav>
  );
}

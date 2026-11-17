/** CityThrive fork: shared copy for fleet-wide routes (sidebar, headers, cross-links). */
export const fleetSiteTableLabel = "Site table";
export const fleetChartsLabel = "Charts & trends";

const FLEET_PATHS = [
  "/overview",
  "/dashboard",
  "/domain-health",
  "/ga4-setup",
  "/all-reports",
] as const;

export function isFleetWorkspaceRoute(pathname: string): boolean {
  return FLEET_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

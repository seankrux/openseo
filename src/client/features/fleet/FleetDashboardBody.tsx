import { FleetDashboardMetrics } from "./FleetDashboardMetrics";

import { FleetDashboardTrends } from "./FleetDashboardTrends";

import { FleetDashboardCoverage } from "./FleetDashboardCoverage";

import { FleetDashboardAudits } from "./FleetDashboardAudits";

import { type Fleet } from "./FleetDashboardParts";

import { DomainsNotAlive } from "./FleetDomainHealth";

export function FleetBody({ d }: { d: Fleet }) {
  return (
    <>
      <FleetDashboardMetrics d={d} />

      <FleetDashboardTrends d={d} />

      <FleetDashboardCoverage d={d} />

      <FleetDashboardAudits d={d} />

      <DomainsNotAlive health={d.health} />
    </>
  );
}

// CityThrive fork: all-sites dashboard.
import { createFileRoute } from "@tanstack/react-router";
import { FleetDashboardPage } from "@/client/features/fleet/FleetDashboardPage";

export const Route = createFileRoute("/_app/dashboard")({
  component: FleetDashboardPage,
});

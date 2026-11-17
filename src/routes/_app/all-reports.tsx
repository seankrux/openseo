// CityThrive fork: all-sites reports and CSV exports.
import { createFileRoute } from "@tanstack/react-router";
import { AllReportsPage } from "@/client/features/fleet/AllReportsPage";

export const Route = createFileRoute("/_app/all-reports")({
  component: AllReportsPage,
});

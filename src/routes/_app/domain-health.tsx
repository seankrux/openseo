// CityThrive fork: Domain health for every project domain.
import { createFileRoute } from "@tanstack/react-router";
import { DomainHealthPage } from "@/client/features/fleet/DomainHealthPage";

export const Route = createFileRoute("/_app/domain-health")({
  component: DomainHealthPage,
});

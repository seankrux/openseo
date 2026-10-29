import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { SkeletonPage } from "@/client/components/SkeletonPresets";

export const Route = createFileRoute("/_app/")({
  component: IndexRedirect,
});

// CityThrive fork: home is the all-sites dashboard. It needs no project, so
// nothing waits on the (1,600-project) list; the dashboard reports its own
// errors.
function IndexRedirect() {
  const navigate = useNavigate();
  useEffect(() => {
    void navigate({ to: "/dashboard", replace: true });
  }, [navigate]);
  return <SkeletonPage />;
}

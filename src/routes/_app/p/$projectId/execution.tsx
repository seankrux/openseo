import { createFileRoute } from "@tanstack/react-router";
import { SeoExecutionPage } from "@/client/features/seo-execution/SeoExecutionPage";

export const Route = createFileRoute("/_app/p/$projectId/execution")({
  component: ExecutionRoute,
});

function ExecutionRoute() {
  const { projectId } = Route.useParams();
  return <SeoExecutionPage projectId={projectId} />;
}

import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PromptExplorerPage } from "@/client/features/ai-search/PromptExplorerPage";
import { ProjectWebsiteGate } from "@/client/features/projects/ProjectWebsiteGate";
import { projectsQueryOptions } from "@/client/features/projects/projectQueries";
import {
  promptExplorerSearchSchema,
  type PromptExplorerModel,
} from "@/types/schemas/ai-search";

export const Route = createFileRoute("/_app/p/$projectId/prompt-explorer")({
  validateSearch: promptExplorerSearchSchema,
  component: PromptExplorerRoute,
});

function PromptExplorerRoute() {
  const { projectId } = Route.useParams();
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const projectsQuery = useQuery(projectsQueryOptions());
  const projectDomain =
    projectsQuery.data?.find((p) => p.id === projectId)?.domain ?? "";

  const urlState = useMemo(
    () => ({
      prompt: search.q ?? "",
      highlightBrand: search.hb ?? projectDomain,
      models:
        search.models && search.models.length > 0
          ? search.models
          : (["chat_gpt", "claude", "gemini"] satisfies PromptExplorerModel[]),
      webSearch: search.web ?? true,
      webSearchCountryCode: search.cc,
    }),
    [search, projectDomain],
  );

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-5" key={projectId}>
        <ProjectWebsiteGate projectId={projectId}>
          <PromptExplorerPage
            projectId={projectId}
            urlState={urlState}
            onSubmit={(values) => {
              void navigate({
                search: {
                  q: values.prompt,
                  models: values.models,
                  web: values.webSearch ? undefined : false,
                  cc: values.webSearchCountryCode,
                  hb: values.highlightBrand || undefined,
                },
                replace: true,
              });
            }}
            onClear={() => {
              void navigate({ search: {}, replace: true });
            }}
          />
        </ProjectWebsiteGate>
      </div>
    </div>
  );
}

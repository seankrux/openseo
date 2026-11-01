import * as React from "react";
import { projectsQueryOptions } from "@/client/features/projects/projectQueries";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  getArchivedProjects,
  restoreProject,
} from "@/serverFunctions/projects";
import { PageHeader, SectionHeader } from "@/client/components/PageHeader";
import { QueryState } from "@/client/components/QueryState";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import { Label } from "@/client/components/ui/label";
import { TablePagination } from "@/client/components/table/TablePagination";
import { getLastProjectId } from "@/client/lib/active-project";
import { fleetSiteTableLabel } from "@/client/navigation/fleetNav";
import { CreateProjectModal } from "@/client/features/projects/CreateProjectModal";
import type { ProjectSummary } from "@/client/features/projects/types";

export const Route = createFileRoute("/_app/projects")({
  component: ProjectsPage,
});

function ProjectsPage() {
  const [creating, setCreating] = React.useState(false);
  // Read after mount to keep SSR/first render stable.
  const [currentProjectId, setCurrentProjectId] = React.useState<string | null>(
    null,
  );
  React.useEffect(() => {
    setCurrentProjectId(getLastProjectId());
  }, []);
  const projectsQuery = useQuery(projectsQueryOptions());

  return (
    <div className="h-full overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <PageHeader
          title="Projects"
          description="Each project has its own Search Console, rank tracking, and audits."
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                nativeButton={false}
                render={<Link to="/overview" />}
              >
                {fleetSiteTableLabel}
              </Button>
              <Button onClick={() => setCreating(true)}>
                <Plus data-icon="inline-start" />
                New project
              </Button>
            </div>
          }
        />

        <QueryState
          query={projectsQuery}
          errorFallback="Failed to load projects"
        >
          {(data) => (
            <ProjectsList projects={data} currentProjectId={currentProjectId} />
          )}
        </QueryState>

        <ArchivedProjects />
      </div>

      {creating ? (
        <CreateProjectModal onClose={() => setCreating(false)} />
      ) : null}
    </div>
  );
}

const PROJECTS_PER_PAGE = 50;

function ProjectsList({
  projects,
  currentProjectId,
}: {
  projects: ProjectSummary[];
  currentProjectId: string | null;
}) {
  const [search, setSearch] = React.useState("");
  const [page, setPage] = React.useState(1);
  const listRef = React.useRef<HTMLUListElement>(null);
  const filteredProjects = React.useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(query) ||
        project.domain?.toLowerCase().includes(query),
    );
  }, [projects, search]);
  const currentPage = Math.min(
    page,
    Math.max(1, Math.ceil(filteredProjects.length / PROJECTS_PER_PAGE)),
  );
  const start = (currentPage - 1) * PROJECTS_PER_PAGE;
  const visibleProjects = filteredProjects.slice(
    start,
    start + PROJECTS_PER_PAGE,
  );

  function changePage(nextPage: number) {
    setPage(nextPage);
    // Take keyboard and pointer users to the start of the newly shown page.
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLAnchorElement>("a")?.focus();
      listRef.current?.scrollIntoView({ block: "start" });
    });
  }

  return (
    <div className="space-y-3">
      <div className="max-w-md space-y-2">
        <Label htmlFor="project-search">Find a project</Label>
        <Input
          id="project-search"
          type="search"
          placeholder="Search by name or domain"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          aria-controls="project-list"
        />
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {filteredProjects.length === 0
          ? search.trim()
            ? "No projects match your search. Try another name or domain."
            : "No projects yet. Create a project to get started."
          : `Showing ${(start + 1).toLocaleString()}–${Math.min(start + PROJECTS_PER_PAGE, filteredProjects.length).toLocaleString()} of ${filteredProjects.length.toLocaleString()} projects${search.trim() ? ` matching “${search.trim()}”` : ""}.`}
      </p>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <ul id="project-list" ref={listRef} className="divide-y divide-border">
          {visibleProjects.map((project) => (
            <li key={project.id}>
              <Link
                to="/p/$projectId/settings"
                params={{ projectId: project.id }}
                className="flex items-center justify-between gap-3 p-3 transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                title={project.name}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{project.name}</span>
                    {project.id === currentProjectId ? (
                      <Badge variant="secondary" size="sm" className="shrink-0">
                        Current
                      </Badge>
                    ) : null}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {project.domain ?? "No domain set"}
                  </span>
                </span>
                <ChevronRight
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              </Link>
            </li>
          ))}
        </ul>
        {filteredProjects.length > PROJECTS_PER_PAGE ? (
          <TablePagination
            page={currentPage}
            pageSize={PROJECTS_PER_PAGE}
            totalCount={filteredProjects.length}
            onPageChange={changePage}
          />
        ) : null}
      </div>
    </div>
  );
}

function ArchivedProjects() {
  const queryClient = useQueryClient();
  const archivedQuery = useQuery({
    queryKey: ["projects", "archived"],
    queryFn: () => getArchivedProjects(),
  });
  const archived = archivedQuery.data ?? [];

  const restoreMutation = useMutation({
    mutationFn: (projectId: string) =>
      restoreProject({ data: { archivedProjectId: projectId } }),
    onSuccess: async () => {
      // Prefix match invalidates both the active and archived lists.
      await queryClient.invalidateQueries({
        queryKey: projectsQueryOptions().queryKey,
      });
      toast.success("Project restored");
    },
  });

  if (archived.length === 0) return null;

  return (
    <section className="space-y-3">
      <SectionHeader title="Archived" />
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {archived.map((project) => (
          <li
            key={project.id}
            className="flex items-center justify-between gap-3 p-3"
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-muted-foreground">
                {project.name}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {project.domain ?? "No domain set"}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => restoreMutation.mutate(project.id)}
              disabled={restoreMutation.isPending}
            >
              Restore
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

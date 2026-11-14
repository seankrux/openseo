import * as React from "react";
import { projectsQueryOptions } from "@/client/features/projects/projectQueries";
import { Link, useLocation } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  MissingSeoSetupModal,
  SeoApiStatusBanners,
} from "@/client/layout/AppShellParts";
import { GscReEngagementModal } from "@/client/features/gsc/GscReEngagementModal";
import { Sidebar } from "@/client/components/Sidebar";
import { BILLING_ROUTE } from "@/shared/billing";
import { getSeoApiKeyStatus } from "@/serverFunctions/config";
import {
  ActiveProjectContext,
  getLastProjectId,
  setLastProjectId,
} from "@/client/lib/active-project";
import { dataforseoHelpLinkOptions } from "@/client/navigation/items";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/client/components/ui/sidebar";

export function AuthenticatedAppLayout({
  children,
  projectId,
  ready,
  banner,
}: {
  children: React.ReactNode;
  projectId?: string;
  /** The session is confirmed. Until then the shell renders but loads nothing. */
  ready: boolean;
  banner?: React.ReactNode;
}) {
  const location = useLocation();
  const [showMissingSeoApiKeyModal, setShowMissingSeoApiKeyModal] =
    React.useState(false);

  const projectsQuery = useQuery({
    ...projectsQueryOptions(),
    enabled: ready && !projectId,
  });
  const rememberedProjectId = getLastProjectId();
  const fallbackProjects = projectsQuery.data ?? [];
  const hasDomainProjects = fallbackProjects.some((p) => Boolean(p.domain));
  const rememberedProject = fallbackProjects.find(
    (project) => project.id === rememberedProjectId,
  );
  const validRememberedId =
    rememberedProject &&
    (!hasDomainProjects || Boolean(rememberedProject.domain))
      ? rememberedProject.id
      : undefined;
  const firstDomainProject = fallbackProjects.find((p) => Boolean(p.domain));
  const fallbackProjectId =
    validRememberedId ??
    firstDomainProject?.id ??
    fallbackProjects[0]?.id ??
    null;

  // Heal stale localStorage projectId (e.g. archived Default project) as soon as projects load.
  React.useEffect(() => {
    if (!projectsQuery.isSuccess || !fallbackProjectId) return;
    if (rememberedProjectId !== fallbackProjectId) {
      setLastProjectId(fallbackProjectId);
    }
  }, [projectsQuery.isSuccess, fallbackProjectId, rememberedProjectId]);

  const sidebarProjectId =
    projectId ??
    (projectsQuery.isSuccess
      ? fallbackProjectId
      : (fallbackProjectId ?? rememberedProjectId));
  const sidebarProjectPending =
    sidebarProjectId === null && projectsQuery.isPending;

  const shouldCheckSeoApiKeyStatus =
    location.pathname !== BILLING_ROUTE &&
    location.pathname !== dataforseoHelpLinkOptions.to;
  // Always loaded once the session is known: the sidebar hides tools that
  // need a DataForSEO key, on every page, not only where the banner applies.
  const seoApiKeyStatusQuery = useQuery({
    queryKey: ["seoApiKeyStatus"],
    queryFn: () => getSeoApiKeyStatus(),
    enabled: ready,
  });
  const isSeoApiKeyConfigured = shouldCheckSeoApiKeyStatus
    ? (seoApiKeyStatusQuery.data?.configured ?? null)
    : null;
  const seoApiKeyStatusError =
    shouldCheckSeoApiKeyStatus && seoApiKeyStatusQuery.isError;

  React.useEffect(() => {
    setShowMissingSeoApiKeyModal(false);
  }, [
    location.pathname,
    seoApiKeyStatusQuery.data,
    seoApiKeyStatusQuery.isError,
    seoApiKeyStatusQuery.isSuccess,
    shouldCheckSeoApiKeyStatus,
  ]);

  const projectTool = location.pathname.split("/")[3];
  const requiresMeasuredSeoData =
    Boolean(projectId) &&
    (["keywords", "domain", "backlinks", "rank-tracking"].includes(
      projectTool ?? "",
    ) ||
      location.pathname.endsWith("/ai-visibility/research"));
  const shouldShowSeoApiWarning =
    requiresMeasuredSeoData &&
    !seoApiKeyStatusError &&
    isSeoApiKeyConfigured === false &&
    !showMissingSeoApiKeyModal;

  return (
    <SidebarProvider className="h-[100dvh] min-h-0 overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-4 focus:py-3 focus:text-foreground focus:shadow-lg"
      >
        Skip to main content
      </a>
      <Sidebar
        projectId={sidebarProjectId}
        projectPending={sidebarProjectPending}
        ready={ready}
        dataforseoConfigured={seoApiKeyStatusQuery.data?.configured ?? null}
      />
      <SidebarInset className="min-h-0 overflow-hidden md:!m-0 md:!mt-2 md:!rounded-none md:!rounded-tl-lg md:border-l md:border-t md:border-sidebar-border md:!shadow-none">
        <MobileTopBar />
        <SeoApiStatusBanners
          shouldShowSeoApiWarning={shouldShowSeoApiWarning}
          seoApiKeyStatusError={requiresMeasuredSeoData && seoApiKeyStatusError}
        />
        {banner}
        <div
          id="main-content"
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-auto"
        >
          <ActiveProjectContext.Provider value={sidebarProjectId}>
            {children}
          </ActiveProjectContext.Provider>
        </div>
      </SidebarInset>

      {showMissingSeoApiKeyModal ? (
        <MissingSeoSetupModal
          onClose={() => setShowMissingSeoApiKeyModal(false)}
        />
      ) : null}

      {ready ? (
        <GscReEngagementModal
          projectId={sidebarProjectId}
          suppressed={showMissingSeoApiKeyModal}
        />
      ) : null}
    </SidebarProvider>
  );
}

function MobileTopBar() {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1.5 md:hidden">
      <SidebarTrigger aria-label="Toggle sidebar" />
      <Link to="/" className="ml-1 font-semibold text-foreground">
        OpenSEO
      </Link>
    </div>
  );
}

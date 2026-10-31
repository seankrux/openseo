import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CardShell } from "@/client/components/CardShell";
import { ErrorState } from "@/client/components/ErrorState";
import { PermissionHint } from "@/client/components/PermissionHint";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/client/components/ui/radio-group";
import { Skeleton } from "@/client/components/ui/skeleton";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  disconnectBing,
  getBingConnection,
  listBingSites,
  setBingSite,
} from "@/serverFunctions/bing";

type BingConnection = Awaited<ReturnType<typeof getBingConnection>>;

function BingConnectionStatus({ connection }: { connection?: BingConnection }) {
  if (!connection) return null;
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {connection.connected || connection.connectorAvailable ? (
        <Badge variant={connection.connected ? "success" : "outline"}>
          {connection.connected ? "Connected" : "Not connected"}
        </Badge>
      ) : null}
      {!connection.connectorAvailable ? (
        <Badge variant="warning">Setup required</Badge>
      ) : null}
    </div>
  );
}

export function BingConnectionCard({ projectId }: { projectId: string }) {
  return <ProjectBingConnectionCard key={projectId} projectId={projectId} />;
}

function ProjectBingConnectionCard({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const pickerId = useId();
  const [picking, setPicking] = useState(false);
  const [selection, setSelection] = useState<string | null>(null);
  const connectionKey = ["bingConnection", projectId];
  const sitesKey = ["bingSites", projectId];
  const connectionQuery = useQuery({
    queryKey: connectionKey,
    queryFn: () => getBingConnection({ data: { projectId } }),
  });
  const connection = connectionQuery.data;
  const connected = connection?.connected === true;
  const canManage = connection?.canManage === true;
  const connectorAvailable = connection?.connectorAvailable === true;
  const showPicker = picking && canManage && connectorAvailable;
  const sitesQuery = useQuery({
    queryKey: sitesKey,
    queryFn: () => listBingSites({ data: { projectId } }),
    enabled: showPicker,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const sites = sitesQuery.data?.sites ?? [];

  function afterChange() {
    setPicking(false);
    setSelection(null);
    queryClient.removeQueries({ queryKey: sitesKey });
    for (const queryKey of [
      connectionKey,
      ["reports", projectId],
      ["report", projectId],
      ["portfolioOverview"],
    ]) {
      void queryClient.invalidateQueries({ queryKey });
    }
  }

  const saveMutation = useMutation({
    meta: { errorToast: false },
    mutationFn: (siteUrl: string) =>
      setBingSite({ data: { projectId, siteUrl } }),
    onSuccess: (saved) => {
      queryClient.setQueryData<BingConnection>(connectionKey, (current) =>
        current ? { ...current, ...saved } : current,
      );
      afterChange();
    },
  });
  const disconnectMutation = useMutation({
    meta: { errorToast: false },
    mutationFn: () => disconnectBing({ data: { projectId } }),
    onSuccess: () => {
      queryClient.setQueryData<BingConnection>(connectionKey, (current) =>
        current
          ? { ...current, connected: false, siteUrl: null, connectedAt: null }
          : current,
      );
      afterChange();
    },
  });
  const changing = saveMutation.isPending || disconnectMutation.isPending;
  const canSave =
    selection !== null &&
    sites.some((site) => site.siteUrl === selection) &&
    sitesQuery.isSuccess &&
    !sitesQuery.isFetching &&
    !connectionQuery.isError;
  const mutationError = saveMutation.error ?? disconnectMutation.error;

  function startPicking() {
    saveMutation.reset();
    disconnectMutation.reset();
    setSelection(null);
    setPicking(true);
  }

  return (
    <CardShell
      title="Bing Webmaster Tools"
      action={<BingConnectionStatus connection={connection} />}
    >
      <p className="mb-4 text-sm text-muted-foreground">
        Use the Bing connection installed for this workspace.
      </p>
      {connectionQuery.isPending ? (
        <div
          role="status"
          aria-label="Loading Bing connection"
          className="space-y-3"
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-9 w-28" />
        </div>
      ) : null}
      {connectionQuery.isError ? (
        <div className="mb-4">
          <ErrorState
            message={getStandardErrorMessage(
              connectionQuery.error,
              "Couldn't check this project's Bing connection.",
            )}
            onRetry={() => void connectionQuery.refetch()}
            isRetrying={connectionQuery.isFetching}
          />
        </div>
      ) : null}
      {connection ? (
        <div className="space-y-4">
          {connected && connection.siteUrl ? (
            <div>
              <p className="text-xs text-muted-foreground">Connected site</p>
              <p className="mt-1 break-all font-medium">{connection.siteUrl}</p>
            </div>
          ) : null}
          {!connectorAvailable ? (
            <p className="text-sm text-muted-foreground">
              The Bing connector is not configured for this workspace. Ask a
              workspace administrator to finish setup.
            </p>
          ) : null}
          {showPicker ? (
            <fieldset disabled={changing} className="space-y-4">
              <legend className="mb-3 text-sm font-medium">
                Verified Bing sites
              </legend>
              {sitesQuery.isPending ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading verified sites…
                </p>
              ) : sitesQuery.isError ? (
                <ErrorState
                  message={getStandardErrorMessage(
                    sitesQuery.error,
                    "Couldn't load verified Bing sites.",
                  )}
                  onRetry={() => void sitesQuery.refetch()}
                  isRetrying={sitesQuery.isFetching}
                />
              ) : sites.length === 0 ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    No verified sites are available from this workspace's Bing
                    connection. Ask a workspace administrator to add or verify a
                    site in Bing Webmaster Tools, then refresh.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    pending={sitesQuery.isFetching}
                    onClick={() => void sitesQuery.refetch()}
                  >
                    Refresh sites
                  </Button>
                </div>
              ) : (
                <RadioGroup
                  aria-label="Choose a verified Bing site"
                  value={selection ?? ""}
                  onValueChange={(value) =>
                    setSelection(typeof value === "string" ? value : null)
                  }
                  disabled={changing || sitesQuery.isFetching}
                  className="max-h-64 overflow-y-auto rounded-lg border border-border p-3"
                >
                  {sites.map((site, index) => (
                    <label
                      key={site.siteUrl}
                      htmlFor={`${pickerId}-${index}`}
                      className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-muted"
                    >
                      <RadioGroupItem
                        id={`${pickerId}-${index}`}
                        value={site.siteUrl}
                      />
                      <span className="min-w-0 break-all">{site.siteUrl}</span>
                      {site.isSelected ? (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          Current site
                        </span>
                      ) : null}
                    </label>
                  ))}
                </RadioGroup>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  pending={saveMutation.isPending}
                  disabled={!canSave || changing}
                  onClick={() => selection && saveMutation.mutate(selection)}
                >
                  Save site
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setPicking(false);
                    setSelection(null);
                    saveMutation.reset();
                  }}
                >
                  Cancel
                </Button>
              </div>
            </fieldset>
          ) : !connected && connectorAvailable ? (
            <p className="text-sm text-muted-foreground">
              Choose a verified Bing site to connect this project.
            </p>
          ) : null}
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              {!showPicker && connectorAvailable ? (
                <Button
                  type="button"
                  variant={connected ? "outline" : "default"}
                  disabled={
                    changing ||
                    connectionQuery.isError ||
                    connectionQuery.isFetching
                  }
                  onClick={startPicking}
                >
                  {connected ? "Change site" : "Connect Bing"}
                </Button>
              ) : null}
              {connected ? (
                <Button
                  type="button"
                  variant="outline"
                  pending={disconnectMutation.isPending}
                  disabled={changing}
                  onClick={() => {
                    saveMutation.reset();
                    disconnectMutation.mutate();
                  }}
                >
                  Disconnect
                </Button>
              ) : null}
            </div>
          ) : (
            <PermissionHint action="change this project's Bing connection" />
          )}
          {mutationError ? (
            <p role="alert" className="text-sm text-destructive">
              {getStandardErrorMessage(mutationError)}
            </p>
          ) : null}
        </div>
      ) : null}
    </CardShell>
  );
}

// CityThrive fork: fleet re-audit controls on the site table. A schedule
// re-runs stale audits a few at a time; "this view" re-audits whatever the
// table is filtered to, through the same paced queue.
import { Button } from "@/client/components/ui/button";
import {
  clearFleetReauditQueue,
  getFleetReauditStatus,
  queueFleetReaudit,
  setFleetReauditMode,
} from "@/serverFunctions/portfolio";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type Status = Awaited<ReturnType<typeof getFleetReauditStatus>>;
type Mode = Status["mode"];

const TICK_MINUTES = 5;
const PACED_MODES = [
  { mode: "gentle", label: "Gentle" },
  { mode: "normal", label: "Normal" },
  { mode: "fast", label: "Fast" },
] as const;
const MODES: readonly Mode[] = ["off", ...PACED_MODES.map((m) => m.mode)];
const isMode = (value: string): value is Mode =>
  MODES.some((mode) => mode === value);
const n = (v: number) => v.toLocaleString("en-US");

/** Picked sites drain at the normal pace while the schedule is off. */
function pace(status: Status) {
  return status.rates[status.mode === "off" ? "normal" : status.mode].perTick;
}

function drainTime(sites: number, perTick: number) {
  const minutes = Math.ceil(sites / perTick) * TICK_MINUTES;
  if (minutes < 90) return `about ${minutes} minutes`;
  const hours = minutes / 60;
  if (hours < 48) return `about ${Math.round(hours)} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

export function FleetReauditControls({
  status,
  viewCount,
  busy,
  onMode,
  onQueueView,
  onCancelQueue,
}: {
  status: Status;
  viewCount: number;
  busy: boolean;
  onMode: (mode: Mode) => void;
  onQueueView: () => void;
  onCancelQueue: () => void;
}) {
  const tick = status.lastTick;
  return (
    <section
      aria-label="Site audits"
      className="space-y-2 rounded-lg border px-4 py-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="font-medium">
          {status.due > 0
            ? `${n(status.due)} sites have audits older than ${status.staleDays} days`
            : `Every audit is under ${status.staleDays} days old`}
        </p>
        {status.running + status.queued > 0 && (
          <p className="text-muted-foreground">
            {n(status.running)} running · {n(status.queued)} waiting
          </p>
        )}
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Re-audit schedule</span>
          <select
            className="h-8 rounded-md border bg-background px-2"
            value={status.mode}
            disabled={busy}
            onChange={(e) => {
              if (isMode(e.target.value)) onMode(e.target.value);
            }}
          >
            <option value="off">Off</option>
            {PACED_MODES.map(({ mode, label }) => (
              <option key={mode} value={mode}>
                {`${label}, ${status.rates[mode].perTick} every ${TICK_MINUTES} min`}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || viewCount === 0}
          onClick={onQueueView}
        >
          {`Re-audit ${n(viewCount)} ${viewCount === 1 ? "site" : "sites"} in this view`}
        </Button>
        {status.queued > 0 && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onCancelQueue}
          >
            {`Cancel ${n(status.queued)} waiting`}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {`This view takes ${drainTime(viewCount, pace(status))} at the ${status.mode === "off" ? "normal" : status.mode} pace. Each audit repeats the site's last audit settings.`}
        {tick &&
          ` Last run started ${n(tick.started)}${
            tick.failed
              ? `; ${n(tick.failed)} could not start (${[...new Set(tick.errors.map((e) => e.code))].join(", ")})`
              : ""
          }.`}
      </p>
    </section>
  );
}

export function FleetReauditPanel({
  viewProjectIds,
}: {
  viewProjectIds: string[];
}) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["fleetReaudit"],
    queryFn: () => getFleetReauditStatus(),
    refetchInterval: (q) =>
      (q.state.data?.running ?? 0) + (q.state.data?.queued ?? 0) > 0
        ? 60_000
        : false,
  });
  const onDone = (status: Status) =>
    queryClient.setQueryData(["fleetReaudit"], status);
  const mode = useMutation({
    mutationFn: (next: Mode) => setFleetReauditMode({ data: { mode: next } }),
    onSuccess: onDone,
  });
  const queue = useMutation({
    mutationFn: () =>
      queueFleetReaudit({ data: { projectIds: viewProjectIds } }),
    onSuccess: onDone,
  });
  const cancel = useMutation({
    mutationFn: () => clearFleetReauditQueue(),
    onSuccess: onDone,
  });
  if (!query.data) return null;
  const status = query.data;
  return (
    <FleetReauditControls
      status={status}
      viewCount={viewProjectIds.length}
      busy={mode.isPending || queue.isPending || cancel.isPending}
      onMode={(next) => mode.mutate(next)}
      onQueueView={() => {
        const count = viewProjectIds.length;
        if (
          count <= 10 ||
          window.confirm(
            `Re-audit ${count.toLocaleString("en-US")} sites? They start ${pace(status)} every ${TICK_MINUTES} minutes and finish in ${drainTime(count, pace(status))}. Each crawl repeats the site's last audit settings.`,
          )
        )
          queue.mutate();
      }}
      onCancelQueue={() => cancel.mutate()}
    />
  );
}

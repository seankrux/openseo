import { ArrowUpRight, Check } from "lucide-react";
import type { SeoExecutionAction } from "@/shared/seo-execution/plan";

const number = new Intl.NumberFormat("en-US");

export function Kpi({
  title,
  value,
  description,
}: {
  title: string;
  value: number;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {title}
      </p>
      <p className="mt-2 text-3xl font-semibold tabular-nums">
        {number.format(value)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

export function ActionRow({
  action,
  selected,
  onSelect,
}: {
  action: SeoExecutionAction;
  selected: boolean;
  onSelect: (id: string, checked: boolean) => void;
}) {
  const evidence = action.evidence;
  const isGap = action.priority === "needs_data";
  return (
    <article className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-primary"
          aria-label={`Include action for ${action.page} in review packet`}
          checked={selected}
          onChange={(event) => onSelect(action.id, event.target.checked)}
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={
                "rounded-full px-2.5 py-1 text-xs font-medium " +
                (isGap
                  ? "bg-muted text-muted-foreground"
                  : action.priority === "high"
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-foreground")
              }
            >
              {isGap
                ? "Measurement needed"
                : `${action.score}/100 priority score`}
            </span>
            <span className="text-xs text-muted-foreground">
              {isGap ? "GSC-only evidence" : "GSC + GA4 evidence"}
            </span>
          </div>
          <div>
            <h3 className="font-semibold leading-snug">{action.title}</h3>
            <a
              className="mt-1 inline-flex max-w-full items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
              href={action.page}
              target="_blank"
              rel="noreferrer"
            >
              <span className="truncate">{action.page}</span>
              <ArrowUpRight className="size-3 shrink-0" aria-hidden />
            </a>
          </div>
          <p className="text-sm text-foreground/80">{action.nextStep}</p>
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ["Impressions", number.format(evidence.impressions)],
              ["Clicks", number.format(evidence.clicks)],
              [
                "Avg position",
                evidence.position === null
                  ? "Unavailable"
                  : evidence.position.toFixed(1),
              ],
              [
                "GA4 key events",
                evidence.keyEvents === null
                  ? "Not matched"
                  : number.format(evidence.keyEvents),
              ],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg bg-muted/60 px-3 py-2">
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <details className="group rounded-lg border border-border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              Evidence and review checklist
            </summary>
            <p className="mt-3 text-xs text-muted-foreground">
              {action.rationale}
            </p>
            <ul className="mt-3 space-y-2">
              {action.checklist.map((step) => (
                <li key={step} className="flex gap-2 text-sm">
                  <Check
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span>{step}</span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      </div>
    </article>
  );
}

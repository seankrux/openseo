import { useMemo, useRef, useState } from "react";
import { trackTool } from "@/lib/free-tools/analytics";
import { FIELD_CLASS, FieldLabel } from "@/lib/free-tools/form";
import {
  parseGoogleBusinessInput,
  type GoogleBusinessLinks,
} from "@/lib/free-tools/google-business-links";

type Mode = "review" | "cid";

function LinkRow({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="rounded-lg border border-[var(--color-border-subtle)] bg-neutral-50 p-3">
      <p className="text-xs font-medium text-[var(--color-brand-muted)]">
        {label}
      </p>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          readOnly
          value={value}
          className={`${FIELD_CLASS} font-mono text-xs`}
          aria-label={label}
        />
        <button
          type="button"
          className="h-11 shrink-0 rounded-lg border border-neutral-900 bg-white px-4 text-sm font-medium text-neutral-950 hover:bg-neutral-50"
          onClick={() => void navigator.clipboard.writeText(value)}
        >
          Copy
        </button>
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-11 shrink-0 items-center justify-center rounded-lg bg-neutral-950 px-4 text-sm font-medium text-white hover:bg-neutral-800"
        >
          Open
        </a>
      </div>
    </div>
  );
}

export function GoogleBusinessLinkTool({
  mode,
  toolSlug,
}: {
  mode: Mode;
  toolSlug: string;
}) {
  const [input, setInput] = useState("");
  const parsed = useMemo(
    () => parseGoogleBusinessInput(input),
    [input],
  ) as GoogleBusinessLinks | null;
  const tracked = useRef(false);

  const onChange = (value: string) => {
    setInput(value);
    if (!tracked.current && value.trim().length > 8) {
      tracked.current = true;
      trackTool("tool_run", toolSlug);
      if (parseGoogleBusinessInput(value)) trackTool("tool_result", toolSlug);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--color-border-subtle)] bg-white p-4 md:p-5">
      <div>
        <FieldLabel htmlFor="gbp-input">
          Place ID, CID, or Google Maps URL
        </FieldLabel>
        <textarea
          id="gbp-input"
          rows={3}
          value={input}
          onChange={(e) => onChange(e.target.value)}
          placeholder="ChIJ…, https://www.google.com/maps?cid=…, or a full Maps place link"
          className={`mt-1 ${FIELD_CLASS} min-h-[5.5rem] resize-y py-2.5`}
        />
      </div>

      {input.trim() && !parsed ? (
        <p className="mt-3 text-sm text-amber-800" role="status">
          Could not parse that input. Try a Place ID (starts with ChIJ), a Maps
          URL with{" "}
          <span className="font-mono">cid=</span>, or a link that includes{" "}
          <span className="font-mono">placeid=</span>.
        </p>
      ) : null}

      {parsed ? (
        <div className="mt-4 space-y-3">
          {parsed.note ? (
            <p className="text-sm text-[var(--color-brand-muted)]" role="status">
              {parsed.note}
            </p>
          ) : null}
          {mode === "review" ? (
            <LinkRow label="Review link (customers)" value={parsed.reviewUrl} />
          ) : (
            <>
              <LinkRow label="Maps link (CID)" value={parsed.mapsCidUrl} />
              <LinkRow label="Maps link (Place ID)" value={parsed.mapsPlaceUrl} />
            </>
          )}
          {parsed.placeId ? (
            <p className="text-xs text-[var(--color-brand-muted)]">
              Place ID:{" "}
              <span className="font-mono text-neutral-800">{parsed.placeId}</span>
            </p>
          ) : null}
          {parsed.cidDecimal ? (
            <p className="text-xs text-[var(--color-brand-muted)]">
              CID:{" "}
              <span className="font-mono text-neutral-800">
                {parsed.cidDecimal}
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

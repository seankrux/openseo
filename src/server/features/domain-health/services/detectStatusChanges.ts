import {
  DOMAIN_HEALTH_DOWN_CLASSES,
  SSL_EXPIRING_SOON_DAYS,
  type DomainHealthChangeKind,
  type DomainHealthClass,
} from "@/shared/domain-health";

export type Snapshot = {
  class: DomainHealthClass;
  sslDaysRemaining: number | null;
  ga4Ids: string[];
  gtmIds: string[];
};

export type DetectedChange = {
  kind: DomainHealthChangeKind;
  fromClass: DomainHealthClass | null;
  toClass: DomainHealthClass | null;
  detail: Record<string, unknown>;
};

function isDown(c: DomainHealthClass): boolean {
  return DOMAIN_HEALTH_DOWN_CLASSES.has(c);
}

/** Compare previous vs next snapshot; emit dashboard feed events. */
export function detectStatusChanges(
  prev: Snapshot | null,
  next: Snapshot,
): DetectedChange[] {
  const changes: DetectedChange[] = [];

  if (!prev) return changes;

  if (prev.class !== next.class) {
    changes.push({
      kind: "class_changed",
      fromClass: prev.class,
      toClass: next.class,
      detail: {},
    });
    if (!isDown(prev.class) && isDown(next.class)) {
      changes.push({
        kind: "went_down",
        fromClass: prev.class,
        toClass: next.class,
        detail: {},
      });
    }
    if (isDown(prev.class) && !isDown(next.class)) {
      changes.push({
        kind: "came_back",
        fromClass: prev.class,
        toClass: next.class,
        detail: {},
      });
    }
  }

  const sslWasOk =
    prev.sslDaysRemaining == null || prev.sslDaysRemaining > SSL_EXPIRING_SOON_DAYS;
  const sslNowSoon =
    next.sslDaysRemaining != null &&
    next.sslDaysRemaining >= 0 &&
    next.sslDaysRemaining <= SSL_EXPIRING_SOON_DAYS;
  if (sslWasOk && sslNowSoon) {
    changes.push({
      kind: "ssl_expiring_soon",
      fromClass: prev.class,
      toClass: next.class,
      detail: { sslDaysRemaining: next.sslDaysRemaining },
    });
  }

  const prevGa4 = new Set(prev.ga4Ids);
  const nextGa4 = new Set(next.ga4Ids);
  const removedGa4 = [...prevGa4].filter((id) => !nextGa4.has(id));
  if (removedGa4.length > 0) {
    changes.push({
      kind: "ga4_tag_removed",
      fromClass: prev.class,
      toClass: next.class,
      detail: { removed: removedGa4, remaining: [...nextGa4] },
    });
  }

  const prevGtm = new Set(prev.gtmIds);
  const nextGtm = new Set(next.gtmIds);
  const removedGtm = [...prevGtm].filter((id) => !nextGtm.has(id));
  if (removedGtm.length > 0) {
    changes.push({
      kind: "gtm_tag_removed",
      fromClass: prev.class,
      toClass: next.class,
      detail: { removed: removedGtm, remaining: [...nextGtm] },
    });
  }

  return changes;
}

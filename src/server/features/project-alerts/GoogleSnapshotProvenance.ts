import { z } from "zod";

const periodSchema = z.object({
  startDate: z.string().date(),
  endDate: z.string().date(),
});
const periodsSchema = z
  .object({ current: periodSchema, previous: periodSchema })
  .refine(
    ({ current, previous }) =>
      Date.parse(current.endDate) - Date.parse(current.startDate) ===
        27 * 86400_000 &&
      Date.parse(previous.endDate) - Date.parse(previous.startDate) ===
        27 * 86400_000 &&
      Date.parse(current.startDate) - Date.parse(previous.endDate) ===
        86400_000,
  );
const bindingSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  accountId: z.string().min(1),
  updatedAt: z.string().min(1),
});
export const gscProvenanceSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("gsc"),
    projectId: z.string(),
    organizationId: z.string(),
    property: z.string(),
    binding: bindingSchema,
    periods: periodsSchema,
    // Preserve the portfolio's UTC-derived labels without claiming Pacific-day anchoring.
    dateBasis: z.object({
      timeZone: z.literal("America/Los_Angeles"),
      windowAnchor: z.literal("utc-date"),
      lagDays: z.literal(3),
    }),
    request: z
      .object({
        startDate: z.string().date(),
        endDate: z.string().date(),
        dimensions: z.array(z.string()),
        type: z.string(),
        dataState: z.enum(["all", "final"]),
        rowLimit: z.number().int().positive(),
        startRow: z.number().int().nonnegative().optional(),
        dimensionFilterGroups: z.tuple([]).optional(),
        aggregationType: z.string().optional(),
      })
      .strict(),
    quality: z.object({
      complete: z.boolean(),
      requestVerified: z.boolean(),
      rowsValid: z.boolean(),
      rowCount: z.number().int().nonnegative().max(56),
    }),
  })
  .refine(
    ({ request, periods, quality }) =>
      quality.requestVerified &&
      quality.rowsValid &&
      request.startDate === periods.previous.startDate &&
      request.endDate === periods.current.endDate &&
      request.dimensions.length === 1 &&
      request.dimensions[0] === "date" &&
      request.type === "web" &&
      (request.startRow ?? 0) === 0 &&
      request.rowLimit >= 56 &&
      request.rowLimit <= 25_000 &&
      (!request.aggregationType ||
        request.aggregationType === "auto" ||
        request.aggregationType === "byProperty"),
  );
export type StoredGscProvenance = z.infer<typeof gscProvenanceSchema>;

export const ga4ProvenanceSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("ga4"),
    projectId: z.string(),
    organizationId: z.string(),
    property: z.string(),
    binding: bindingSchema,
    periods: periodsSchema,
    dateBasis: z.object({
      timeZone: z.string().min(1).nullable(),
      windowAnchor: z.literal("utc-date"),
      lagDays: z.literal(1),
    }),
    request: z
      .object({
        dateRanges: z.array(periodSchema),
        dimensions: z.array(z.object({ name: z.string() })),
        metrics: z.array(z.object({ name: z.string() })),
        offset: z.string(),
        limit: z.string(),
        orderBys: z.tuple([]),
        keepEmptyRows: z.literal(false),
        returnPropertyQuota: z.literal(true),
      })
      .strict(),
    quality: z.object({
      complete: z.boolean(),
      rowsValid: z.boolean(),
      rowCount: z.number().int().nonnegative().nullable(),
      sampled: z.boolean().nullable(),
      thresholded: z.boolean().nullable(),
      otherRowLoss: z.boolean().nullable(),
      restricted: z.boolean().nullable(),
    }),
  })
  .refine(
    ({ request, periods, quality }) =>
      quality.rowsValid &&
      (quality.rowCount === null || quality.rowCount <= 2) &&
      request.dateRanges.length === 2 &&
      request.dateRanges[0]?.startDate === periods.current.startDate &&
      request.dateRanges[0]?.endDate === periods.current.endDate &&
      request.dateRanges[1]?.startDate === periods.previous.startDate &&
      request.dateRanges[1]?.endDate === periods.previous.endDate &&
      request.dimensions.length === 0 &&
      request.metrics.length === 2 &&
      request.metrics[0]?.name === "sessions" &&
      request.metrics[1]?.name === "activeUsers" &&
      request.offset === "0" &&
      request.limit === "10",
  );
export type StoredGa4Provenance = z.infer<typeof ga4ProvenanceSchema>;

export function ga4EvidenceLimitations(provenance?: StoredGa4Provenance) {
  const limitations = [
    provenance
      ? "All-channel traffic; not organic traffic, leads or revenue."
      : "All-channel traffic; not organic traffic, leads or revenue. Exact periods and quality were not recorded.",
  ];
  if (!provenance) return limitations;
  const q = provenance.quality;
  if (
    !q.complete ||
    [q.sampled, q.thresholded, q.otherRowLoss, q.restricted].includes(null)
  )
    limitations.push("Response quality or completeness is unknown.");
  if (q.sampled) limitations.push("GA4 reported sampling.");
  if (q.thresholded) limitations.push("GA4 reported thresholding.");
  if (q.otherRowLoss) limitations.push("GA4 reported other-row data loss.");
  if (q.restricted) limitations.push("GA4 reported metric restrictions.");
  if (!provenance.dateBasis.timeZone)
    limitations.push("Property timezone was not reported.");
  return limitations;
}

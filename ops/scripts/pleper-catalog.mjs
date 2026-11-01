#!/usr/bin/env node
/**
 * Phase A: crawl PlePer homepage tool links and emit ops/pleper-tool-matrix.csv
 * Usage: node ops/scripts/pleper-catalog.mjs [--out ops/pleper-tool-matrix.csv]
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOME = "https://www.pleper.com/";
const TOOL_URL = (sdo) =>
  `https://www.pleper.com/index.php?do=tools&sdo=${sdo}`;

const outArg = process.argv.indexOf("--out");
const outPath =
  outArg >= 0
    ? process.argv[outArg + 1]
    : join(ROOT, "ops", "pleper-tool-matrix.csv");

function csvEscape(value) {
  const s = String(value ?? "");
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function extractSdos(html) {
  const re = /sdo=([a-z0-9_]+)/gi;
  const set = new Set();
  for (const m of html.matchAll(re)) set.add(m[1]);
  return [...set].sort();
}

function titleFromHtml(html) {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim() : "";
}

function inputSummary(html) {
  const names = [];
  for (const m of html.matchAll(
    /<(?:input|textarea|select)[^>]*\sname="([^"]+)"/gi,
  )) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names.slice(0, 12).join("; ");
}

function classify(sdo) {
  if (
    sdo.startsWith("scrape_") ||
    sdo === "analyze_google_reviewer" ||
    sdo === "dupe_search" ||
    sdo === "local_rank_tracker"
  )
    return "scrape_or_paid";
  if (
    sdo.includes("link") ||
    sdo === "cid_converter" ||
    sdo === "bookmarklets"
  )
    return "utility_a";
  if (sdo.includes("categor") || sdo === "category_helper") return "reference_b";
  return "other";
}

const homeRes = await fetch(HOME, {
  headers: { "user-agent": "OpenSEO-competitive-intel/1.0" },
});
if (!homeRes.ok) throw new Error(`Homepage ${homeRes.status}`);
const homeHtml = await homeRes.text();
const sdos = extractSdos(homeHtml);
if (sdos.length === 0) throw new Error("No sdo= tools found on homepage");

const rows = [
  [
    "sdo",
    "url",
    "page_title",
    "form_fields",
    "openseo_class",
    "notes",
  ].join(","),
];

for (const sdo of sdos) {
  const url = TOOL_URL(sdo);
  let html = "";
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "OpenSEO-competitive-intel/1.0" },
    });
    html = res.ok ? await res.text() : "";
  } catch {
    html = "";
  }
  const title = titleFromHtml(html);
  const fields = inputSummary(html);
  const klass = classify(sdo);
  const notes =
    klass === "utility_a"
      ? "OpenSEO P1 client or thin wrapper"
      : klass === "reference_b"
        ? "Cache DataForSEO categories or static list"
        : klass === "scrape_or_paid"
          ? "Prefer DataForSEO MCP; avoid direct scrape"
          : "";
  rows.push(
    [
      sdo,
      url,
      title,
      fields,
      klass,
      notes,
    ]
      .map(csvEscape)
      .join(","),
  );
  await new Promise((r) => setTimeout(r, 400));
}

writeFileSync(outPath, rows.join("\n") + "\n", "utf8");
console.log(`Wrote ${sdos.length} tools to ${outPath}`);

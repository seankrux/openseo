import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  ServerResponse,
} from "node:http";
import path from "node:path";
import { pipeline } from "node:stream";
import { promisify } from "node:util";
import {
  brotliCompress,
  constants,
  createBrotliCompress,
  createGzip,
  gzip,
} from "node:zlib";
import type { Plugin } from "vite";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

const ENCODINGS = {
  br: {
    extension: ".br",
    compress: (source: Buffer) =>
      brotli(source, {
        params: {
          // Quality 11 took 8.6 s of CPU for the 120 built files at every
          // container start; 9 takes 2.4 s for 8% more bytes (measured).
          [constants.BROTLI_PARAM_QUALITY]: 9,
          [constants.BROTLI_PARAM_SIZE_HINT]: source.length,
        },
      }),
  },
  gzip: {
    extension: ".gz",
    compress: (source: Buffer) => gzipAsync(source, { level: 9 }),
  },
} as const;
type Encoding = keyof typeof ENCODINGS;
/** Preference order when the client accepts both. */
const PREFERRED: Encoding[] = ["br", "gzip"];

/** Text formats only; woff2 and images are already compressed. */
const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
};
const MIN_BYTES = 1024;
const ASSET_NAME = /^[\w.-]+$/;

function acceptedEncodings(header: string | undefined): Set<string> {
  const accepted = new Set<string>();
  for (const part of (header ?? "").split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    const refused = params.some((p) => /^\s*q=0(\.0*)?\s*$/.test(p));
    if (name && !refused) accepted.add(name);
  }
  return accepted;
}

type Compressed = { file: string; bytes: number; etag: string };

const etagOf = (encoding: Encoding, bytes: number, mtimeMs: number) =>
  `W/"${encoding}-${bytes}-${Math.floor(mtimeMs)}"`;

function appendVary(res: ServerResponse, field: string) {
  const current = res.getHeader("Vary");
  const values = (
    Array.isArray(current) ? current.join(",") : String(current ?? "")
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const lower = field.toLowerCase();
  if (values.some((value) => value === "*" || value.toLowerCase() === lower))
    return;
  res.setHeader("Vary", [...values, field].join(", "));
}

const weak = (tag: string) => tag.trim().replace(/^W\//, "");

function etagMatches(header: string | undefined, etag: string) {
  if (!header) return false;
  return header
    .split(",")
    .some((tag) => tag.trim() === "*" || weak(tag) === weak(etag));
}

/** Server-function payloads, HTML and other text that workerd sends as is. */
const DYNAMIC_TYPES =
  /^\s*(text\/(?!event-stream)|application\/(json|javascript|xml|x-tss-framed|[\w.-]+\+(json|xml))\b|image\/svg\+xml)/i;

function toBuffer(chunk: unknown, textEncoding?: unknown) {
  return typeof chunk === "string"
    ? Buffer.from(
        chunk,
        typeof textEncoding === "string"
          ? (textEncoding as BufferEncoding)
          : undefined,
      )
    : Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(
          (chunk as Uint8Array).buffer,
          (chunk as Uint8Array).byteOffset,
          (chunk as Uint8Array).byteLength,
        );
}

/**
 * Compresses responses that later middleware (the Cloudflare plugin's
 * forward to workerd) writes, when the client accepts it and the body is at
 * least MIN_BYTES. Without a Content-Length, chunks are held only until that
 * much has arrived; after that every chunk is flushed, so streamed HTML still
 * streams.
 */
function compressDynamic(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) {
  const url = req.url ?? "";
  if (url.startsWith("/assets/") || url.startsWith("/cdn-cgi/")) return next();
  const accepted = acceptedEncodings(
    req.headers["accept-encoding"]?.toString(),
  );
  const encoding = PREFERRED.find((e) => accepted.has(e));
  if (!encoding || req.method === "HEAD") return next();
  const writeHead = res.writeHead.bind(res) as (
    status: number,
    reason?: string,
  ) => ServerResponse;
  const write = res.write.bind(res) as (chunk: Buffer) => boolean;
  const end = res.end.bind(res) as (callback?: () => void) => ServerResponse;
  /** null: not decided; false: sent as is; else the compressor. */
  let mode: null | false | ReturnType<typeof createGzip> = null;
  let headPending: { status: number; reason?: string } | null = null;
  const held: Buffer[] = [];
  let heldBytes = 0;

  const flushHead = () => {
    if (!headPending) return;
    const { status, reason } = headPending;
    headPending = null;
    if (reason === undefined) writeHead(status);
    else writeHead(status, reason);
  };
  /** Decide from the headers alone; null while only the size is unknown. */
  const eligible = (): boolean | null => {
    const type = String(res.getHeader("Content-Type") ?? "");
    if (!DYNAMIC_TYPES.test(type)) return false;
    appendVary(res, "Accept-Encoding");
    const status = res.statusCode;
    if (
      status < 200 ||
      status === 204 ||
      status === 206 ||
      status === 304 ||
      res.hasHeader("Content-Encoding")
    )
      return false;
    const length = res.getHeader("Content-Length");
    if (length === undefined) return null;
    return Number(length) >= MIN_BYTES;
  };
  const start = (compress: boolean) => {
    if (!compress) {
      mode = false;
      flushHead();
      for (const chunk of held) write(chunk);
      held.length = 0;
      return;
    }
    res.setHeader("Content-Encoding", encoding);
    res.removeHeader("Content-Length");
    flushHead();
    const zipper =
      encoding === "br"
        ? createBrotliCompress({
            params: { [constants.BROTLI_PARAM_QUALITY]: 4 },
          })
        : createGzip({ level: 6 });
    zipper.on("data", (chunk: Buffer) => {
      if (!write(chunk)) zipper.pause();
    });
    res.on("drain", () => zipper.resume());
    zipper.on("end", () => end());
    zipper.on("error", () => res.destroy());
    res.on("close", () => zipper.destroy());
    mode = zipper;
    for (const chunk of held) zipper.write(chunk);
    held.length = 0;
    zipper.flush();
  };

  res.writeHead = function (statusCode: number, ...rest: unknown[]) {
    const reason =
      typeof rest[0] === "string" ? (rest.shift() as string) : undefined;
    const headers = rest[0] as OutgoingHttpHeaders | string[] | undefined;
    if (Array.isArray(headers)) {
      for (let i = 0; i + 1 < headers.length; i += 2)
        res.appendHeader(headers[i]!, headers[i + 1]!);
    } else if (headers) {
      for (const [name, value] of Object.entries(headers))
        if (value !== undefined) res.setHeader(name, value);
    }
    res.statusCode = statusCode;
    headPending = { status: statusCode, reason };
    if (mode === null) {
      const decision = eligible();
      if (decision !== null) start(decision);
    }
    return res;
  } as unknown as ServerResponse["writeHead"];

  res.write = function (chunk: unknown, ...rest: unknown[]) {
    const callback = rest.find((arg) => typeof arg === "function") as
      | (() => void)
      | undefined;
    const data = toBuffer(chunk, rest[0]);
    if (callback) process.nextTick(callback);
    if (mode === null) {
      headPending ??= { status: res.statusCode };
      const decision = eligible();
      if (decision !== null) start(decision);
    }
    if (mode === null) {
      held.push(data);
      heldBytes += data.length;
      if (heldBytes >= MIN_BYTES) start(true);
      return true;
    }
    if (mode === false) return write(data);
    mode.write(data);
    mode.flush();
    return !res.writableNeedDrain;
  } as unknown as ServerResponse["write"];

  res.end = function (...args: unknown[]) {
    const callback = args.find((arg) => typeof arg === "function") as
      | (() => void)
      | undefined;
    if (callback) res.once("finish", callback);
    const chunk = typeof args[0] === "function" ? undefined : args[0];
    if (chunk !== undefined && chunk !== null) {
      const data = toBuffer(chunk, args[1]);
      if (mode === null) {
        held.push(data);
        heldBytes += data.length;
      } else if (mode === false) write(data);
      else mode.write(data);
    }
    if (mode === null) {
      headPending ??= { status: res.statusCode };
      const decision = eligible();
      start(decision ?? heldBytes >= MIN_BYTES);
    }
    if (mode === false) {
      flushHead();
      end();
    } else mode!.end();
    return res;
  } as unknown as ServerResponse["end"];
  next();
}

/**
 * `vite preview` (the self-hosted server) sends built assets uncompressed, and
 * the tailnet proxy in front of it does not compress either, so the 915 KB
 * entry bundle crossed the wire in full on every cold load. This serves
 * brotli or gzip copies of `dist/client/assets` straight from disk, before
 * the request reaches workerd. The copies are written once, next to the
 * originals, when the preview server starts.
 */
export function precompressedAssets(): Plugin {
  const pending = new Map<string, Promise<Compressed | null>>();

  async function compress(
    assetsDir: string,
    name: string,
    encoding: Encoding,
  ): Promise<Compressed | null> {
    const source = path.join(assetsDir, name);
    const target = source + ENCODINGS[encoding].extension;
    try {
      const sourceStat = await stat(source);
      if (!sourceStat.isFile() || sourceStat.size < MIN_BYTES) return null;
      const existing = await stat(target).catch(() => null);
      if (existing && existing.mtimeMs >= sourceStat.mtimeMs)
        return {
          file: target,
          bytes: existing.size,
          etag: etagOf(encoding, existing.size, existing.mtimeMs),
        };
      const output = await ENCODINGS[encoding].compress(await readFile(source));
      if (output.length >= sourceStat.size) return null;
      // Stage beside client, outside Miniflare's watched asset tree. A temp
      // inside it can disappear between the manifest walk's readdir and stat.
      // Keeping the staging file in the build output permits atomic rename;
      // each compression gets its own path, including across preview processes.
      const temporary = path.join(
        path.dirname(path.dirname(assetsDir)),
        `.openseo-compress-${randomUUID()}.tmp`,
      );
      try {
        await writeFile(temporary, output, { flag: "wx" });
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true });
      }
      const written = await stat(target);
      return {
        file: target,
        bytes: written.size,
        etag: etagOf(encoding, written.size, written.mtimeMs),
      };
    } catch {
      // Missing asset or read-only dist: the uncompressed path still works.
      return null;
    }
  }

  function compressed(assetsDir: string, name: string, encoding: Encoding) {
    const key = `${encoding}:${name}`;
    let work = pending.get(key);
    if (!work) {
      work = compress(assetsDir, name, encoding);
      pending.set(key, work);
    }
    return work;
  }

  async function warm(assetsDir: string) {
    const names = await readdir(assetsDir).catch(() => [] as string[]);
    for (const name of names) {
      if (!CONTENT_TYPES[path.extname(name)]) continue;
      for (const encoding of PREFERRED)
        await compressed(assetsDir, name, encoding);
    }
  }

  return {
    name: "openseo:precompressed-assets",
    // Ahead of the Cloudflare plugin, whose preview middleware forwards every
    // request to workerd.
    enforce: "pre",
    configurePreviewServer(server) {
      const assetsDir = path.resolve(
        server.config.root,
        server.config.build.outDir,
        "client/assets",
      );
      void warm(assetsDir);
      server.middlewares.use(compressDynamic);
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? "";
        if (
          (req.method !== "GET" && req.method !== "HEAD") ||
          !url.startsWith("/assets/")
        )
          return next();
        const name = url.slice("/assets/".length).split("?")[0]!;
        const contentType = CONTENT_TYPES[path.extname(name)];
        if (!contentType || !ASSET_NAME.test(name)) return next();
        const accepted = acceptedEncodings(
          req.headers["accept-encoding"]?.toString(),
        );
        const encoding = PREFERRED.find((e) => accepted.has(e));
        if (!encoding) return next();
        compressed(assetsDir, name, encoding).then((copy) => {
          if (!copy) return next();
          appendVary(res, "Accept-Encoding");
          res.setHeader("ETag", copy.etag);
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          if (
            etagMatches(req.headers["if-none-match"]?.toString(), copy.etag)
          ) {
            res.statusCode = 304;
            return res.end();
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", contentType);
          res.setHeader("Content-Encoding", encoding);
          res.setHeader("Content-Length", copy.bytes);
          if (req.method === "HEAD") return res.end();
          pipeline(createReadStream(copy.file), res, () => undefined);
        }, next);
      });
    },
  };
}

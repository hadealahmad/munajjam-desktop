import { protocol, net } from "electron";
import path from "path";
import fs from "fs";
import { pathToFileURL } from "url";
import { uiOutDir } from "./paths";
import { isPathApproved } from "./approved-paths";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
};

/**
 * Parse an HTTP Range header and return the byte range.
 * Only supports a single `bytes=START-END` range.
 */
function parseRange(header: string | null, fileSize: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  let start = match[1] ? parseInt(match[1], 10) : NaN;
  let end = match[2] ? parseInt(match[2], 10) : NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) return null;

  if (Number.isNaN(start)) {
    // suffix range: bytes=-500 means last 500 bytes
    start = Math.max(0, fileSize - end);
    end = fileSize - 1;
  } else if (Number.isNaN(end)) {
    end = fileSize - 1;
  }

  if (start > end || start < 0 || end >= fileSize) return null;
  return { start, end };
}

/**
 * Serve a local file with full HTTP range-request support so that
 * `<audio>` / `<video>` elements can seek freely.
 */
function serveFileWithRanges(filePath: string, rangeHeader: string | null): Response {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";

  const range = parseRange(rangeHeader, fileSize);

  if (!range) {
    // Full file response — still advertise that we accept ranges.
    const body = fs.readFileSync(filePath);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(fileSize),
        "Accept-Ranges": "bytes",
      },
    });
  }

  const { start, end } = range;
  const chunkSize = end - start + 1;
  const buf = Buffer.alloc(chunkSize);
  const fd = fs.openSync(filePath, "r");
  fs.readSync(fd, buf, 0, chunkSize, start);
  fs.closeSync(fd);

  return new Response(buf, {
    status: 206,
    headers: {
      "Content-Type": mimeType,
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Content-Length": String(chunkSize),
      "Accept-Ranges": "bytes",
    },
  });
}

export function isWithin(base: string, target: string): boolean {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function toSafeAppFilePath(outDir: string, requestPathname: string): string {
  const stripped = requestPathname.replace(/^\/+/, "");
  if (!stripped || stripped === "/") {
    return path.join(outDir, "en.html");
  }

  const requested = path.join(outDir, stripped);
  if (fs.existsSync(requested) && fs.statSync(requested).isFile()) {
    return requested;
  }

  const htmlCandidate = path.join(outDir, `${stripped}.html`);
  if (fs.existsSync(htmlCandidate) && fs.statSync(htmlCandidate).isFile()) {
    return htmlCandidate;
  }

  return requested;
}

export const registerAppProtocol = () => {
  const outDir = uiOutDir();

  protocol.handle("munajjam-app", (request) => {
    try {
      const url = new URL(request.url);
      const filePath = toSafeAppFilePath(outDir, decodeURIComponent(url.pathname));

      if (!isWithin(outDir, filePath)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return new Response("Not Found", { status: 404 });
      }

      const ext = path.extname(filePath).toLowerCase();
      const mimeType = MIME_TYPES[ext] || "application/octet-stream";

      return net.fetch(pathToFileURL(filePath).href, {
        headers: {
          "Content-Type": mimeType,
          "Cache-Control": "no-store",
        },
      });
    } catch {
      return new Response("Internal error", { status: 500 });
    }
  });
};

export const registerMediaProtocol = () => {
  protocol.handle("munajjam", (request) => {
    try {
      const url = new URL(request.url);
      const rawPath = url.searchParams.get("path");
      if (!rawPath) {
        return new Response("Missing path parameter", { status: 400 });
      }

      const resolved = path.resolve(decodeURIComponent(rawPath));
      if (!isPathApproved(resolved)) {
        return new Response("Forbidden", { status: 403 });
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return new Response("Not Found", { status: 404 });
      }

      return serveFileWithRanges(resolved, request.headers.get("range"));
    } catch {
      return new Response("Internal error", { status: 500 });
    }
  });
};

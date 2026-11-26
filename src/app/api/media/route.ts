import { unauthorized } from "@/lib/auth";
import { contentTypeFor, viewFile } from "@/lib/comfy";
import { errorResponse } from "@/lib/errors";
import { inlineDisposition } from "@/lib/disposition";
import { isUnsafePath, ParamError } from "@/lib/params";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ALLOWED_TYPES = new Set(["output", "temp", "input"]);

/**
 * The most one ranged read asks ComfyUI for. A <video> asks for `bytes=N-`,
 * the whole rest of the file, and drops the read when it seeks. Once
 * deployed, dropping it does not stop this function, which goes on pulling
 * the rest of the file off the ComfyUI machine's uplink: every seek a whole
 * clip's worth, until each new read waits behind dozens of dead ones (a
 * Character swap's shot planner seeks hundreds of times). Capped, a dropped
 * read costs at most this much, and the browser asks for the next piece when
 * it wants it, as a short 206 allows.
 */
const MAX_RANGE_BYTES = 4 * 1024 * 1024;

/** `bytes=N-` or `bytes=N-M`, cut to at most MAX_RANGE_BYTES; anything else as it came. */
function capRange(range: string): string {
  const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
  if (!match) return range;
  const start = Number(match[1]);
  const last = start + MAX_RANGE_BYTES - 1;
  const end = match[2] ? Math.min(Number(match[2]), last) : last;
  return `bytes=${start}-${end}`;
}

function assertSafePath(value: string, field: string): void {
  if (isUnsafePath(value)) throw new ParamError(`Invalid ${field}.`, field);
}

/**
 * Streams a generated file from ComfyUI through to the browser. This exists
 * because the page is served over HTTPS and ComfyUI is plain HTTP — the
 * browser would refuse to load the video directly.
 */
export async function GET(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const search = new URL(request.url).searchParams;
    const filename = search.get("filename");
    const subfolder = search.get("subfolder") ?? "";
    const type = search.get("type") ?? "output";

    if (!filename) throw new ParamError("filename is required.", "filename");
    assertSafePath(filename, "filename");
    assertSafePath(subfolder, "subfolder");
    if (!ALLOWED_TYPES.has(type)) throw new ParamError("Invalid type.", "type");

    // Forward Range so the browser can seek within the video, capped.
    const asked = request.headers.get("range");
    const range = asked ? capRange(asked) : null;
    const upstream = await viewFile(
      { filename, subfolder, type },
      {
        headers: range ? { Range: range } : undefined,
        signal: request.signal,
      },
    );

    const headers = new Headers();
    headers.set(
      "Content-Type",
      upstream.headers.get("content-type") ?? contentTypeFor(filename),
    );
    headers.set("Accept-Ranges", upstream.headers.get("accept-ranges") ?? "bytes");
    headers.set("Cache-Control", "private, max-age=31536000, immutable");
    headers.set("Content-Disposition", inlineDisposition(filename));

    for (const header of ["content-length", "content-range", "etag"]) {
      const value = upstream.headers.get(header);
      if (value) headers.set(header, value);
    }

    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (error) {
    return errorResponse(error);
  }
}

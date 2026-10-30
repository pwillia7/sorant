import { unauthorized } from "@/lib/auth";
import { readFileRange, statFile } from "@/lib/comfy";
import { errorResponse } from "@/lib/errors";
import { mp4Seconds } from "@/lib/mp4";
import { isUnsafePath, ParamError } from "@/lib/params";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export interface OutputFile {
  filename: string;
  subfolder: string;
  type: string;
  url: string;
  modifiedAt: number;
  /** How long it plays, read from its header; null when that could not be read. */
  seconds: number | null;
}

/**
 * The files ComfyUI saved after a given one under the same name, oldest first.
 *
 * For runs this app lost track of: a connection that dropped mid-render, or a
 * restart that emptied ComfyUI's history, leaves the clips on disk with nothing
 * left that says which run wrote them. ComfyUI will not list a subfolder of
 * its output, and the assets API that would is off by default, but a save node
 * numbers its files — `MiniMax_H3_00929_.mp4`, then `_00930_` — so the ones
 * after a known file can be found by asking for each name in turn. A HEAD on
 * `/view` answers that without moving the file, with when it was written, and
 * the first few kilobytes of an MP4 say how long it is (see mp4.ts) — which
 * the browser could only find out by loading each clip through this proxy and
 * the tunnel behind it, a few seconds apiece and timing out in a crowd.
 *
 * Stops at the first few names in a row that are missing — a file deleted
 * along the way is a gap to step over, the end of the run is a longer one —
 * and at a ceiling, so a request cannot walk the counter for ever.
 */
const COUNTED = /^(.+)_(\d{5,})_\.([a-z0-9]+)$/i;
const MISSES_TO_STOP = 3;
const MAX_FILES = 120;
const BATCH = 6;

export async function GET(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const search = new URL(request.url).searchParams;
    const run = search.get("run");
    if (run !== null) return Response.json({ files: await runFiles(run) });
    const after = search.get("after") ?? "";
    const subfolder = search.get("subfolder") ?? "";
    const match = COUNTED.exec(after);
    if (!match) throw new ParamError("after must name a numbered output file.", "after");
    if (isUnsafePath(after) || isUnsafePath(subfolder)) {
      throw new ParamError("Invalid path.", "after");
    }
    const [, prefix, digits, extension] = match;
    const start = Number(digits) + 1;
    const nameFor = (counter: number) =>
      `${prefix}_${String(counter).padStart(digits.length, "0")}_.${extension}`;

    const files: OutputFile[] = [];
    let misses = 0;
    let counter = start;
    while (misses < MISSES_TO_STOP && counter - start < MAX_FILES) {
      const names = Array.from({ length: BATCH }, (_, i) => nameFor(counter + i));
      counter += BATCH;
      const stats = await Promise.all(
        names.map(async (filename) => {
          const ref = { filename, subfolder, type: "output" };
          const stat = await statFile(ref);
          if (!stat) return null;
          const seconds = /\.(mp4|mov|m4v)$/i.test(filename)
            ? await mp4Seconds((from, to) => readFileRange(ref, from, to)).catch(() => null)
            : null;
          return { ...stat, seconds };
        }),
      );
      for (let i = 0; i < names.length && misses < MISSES_TO_STOP; i += 1) {
        const stat = stats[i];
        if (!stat) {
          misses += 1;
          continue;
        }
        misses = 0;
        const query = new URLSearchParams({ filename: names[i], subfolder, type: "output" });
        files.push({
          filename: names[i],
          subfolder,
          type: "output",
          url: `/api/media?${query}`,
          modifiedAt: stat.modifiedAt,
          seconds: stat.seconds,
        });
      }
    }

    return Response.json({ files });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * The files one batched run wrote, by the `filename_prefix` it was given —
 * `video/upscale_1a2b3c4d`. VHS numbers from 1 under a prefix it has not seen,
 * and with a soundtrack keeps the silent file beside the one with sound, so
 * there are at most these two names to ask for, the one with sound first. See
 * `Job.runKey`.
 *
 * A file whose length cannot be read is one a run died writing — an MP4 says
 * how long it is when it is closed — and is left out.
 */
const RUN_KEY = /^[\w-]+(\/[\w-]+)*$/;

async function runFiles(run: string): Promise<OutputFile[]> {
  if (!RUN_KEY.test(run) || isUnsafePath(run)) {
    throw new ParamError("run must be a run's file prefix.", "run");
  }
  const slash = run.lastIndexOf("/");
  const subfolder = slash === -1 ? "" : run.slice(0, slash);
  const base = run.slice(slash + 1);
  const names = [`${base}_00001-audio.mp4`, `${base}_00001.mp4`];
  const stats = await Promise.all(
    names.map(async (filename) => {
      const ref = { filename, subfolder, type: "output" };
      const stat = await statFile(ref);
      if (!stat) return null;
      const seconds = await mp4Seconds((from, to) => readFileRange(ref, from, to)).catch(() => null);
      return seconds === null ? null : { ...stat, seconds };
    }),
  );
  return names.flatMap((filename, i) => {
    const stat = stats[i];
    if (!stat) return [];
    const query = new URLSearchParams({ filename, subfolder, type: "output" });
    return [
      {
        filename,
        subfolder,
        type: "output",
        url: `/api/media?${query}`,
        modifiedAt: stat.modifiedAt,
        seconds: stat.seconds,
      },
    ];
  });
}

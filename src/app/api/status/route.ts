import { unauthorized } from "@/lib/auth";
import {
  collectOutputs,
  getHistoryEntry,
  getQueue,
  type ComfyFileRef,
  type ComfyHistoryEntry,
  type ComfyQueue,
} from "@/lib/comfy";
import { errorResponse } from "@/lib/errors";
import {
  followRun,
  graphOf,
  isUnfinishedBatch,
  runKey,
} from "@/lib/meta-batch";
import { ParamError } from "@/lib/params";
import { briefsFrom } from "@/lib/workflows/brief";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export type GenerationState =
  | "queued"
  | "running"
  | "done"
  | "error"
  | "unknown";

export interface StatusPayload {
  state: GenerationState;
  /** 0-based position in the pending queue; null when running or finished. */
  queuePosition: number | null;
  outputs: Array<ComfyFileRef & { url: string }>;
  error?: string;
  /**
   * What each director wrote, by title, once the run is finished. On a failed
   * run too, where it is often the explanation — a brief that came back as a
   * refusal is a run that rendered something nobody asked for.
   */
  briefs?: Record<string, string>;
  /**
   * When ComfyUI finished the run, by its own clock, in ms. What a run this
   * device lost track of is stamped with when a later check catches up with it
   * — the moment of asking would count the whole outage as render time.
   */
  finishedAt?: number;
}

/** Guards against an oversized fan-out of history lookups. */
const MAX_BATCH = 25;

/** Build the proxied URL the <video> element will actually load. */
function mediaUrl(ref: ComfyFileRef): string {
  const query = new URLSearchParams({
    filename: ref.filename,
    subfolder: ref.subfolder ?? "",
    type: ref.type || "output",
  });
  return `/api/media?${query}`;
}

/**
 * ComfyUI reports failures as ["execution_error", { exception_message, ... }]
 * tuples in the history status. Pull out the first useful message.
 */
function extractError(entry: ComfyHistoryEntry): string | undefined {
  const messages = entry.status?.messages;
  if (!Array.isArray(messages)) return undefined;

  for (const message of messages) {
    if (!Array.isArray(message) || message[0] !== "execution_error") continue;
    const detail = message[1] as
      | { exception_message?: string; node_type?: string; node_id?: string }
      | undefined;
    if (!detail) continue;

    const where = detail.node_type
      ? ` in ${detail.node_type}${detail.node_id ? ` (node ${detail.node_id})` : ""}`
      : "";
    return `${detail.exception_message ?? "Execution failed"}${where}`;
  }

  return undefined;
}

/** A prompt that was cut off rather than failing: ["execution_interrupted", …]. */
function wasInterrupted(entry: ComfyHistoryEntry): boolean {
  const messages = entry.status?.messages;
  return (
    Array.isArray(messages) &&
    messages.some(
      (message) => Array.isArray(message) && message[0] === "execution_interrupted",
    )
  );
}

/** The timestamp ComfyUI put on the message that ended the run, if any. */
function finishedAtOf(entry: ComfyHistoryEntry): number | undefined {
  const messages = entry.status?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (const message of messages) {
    if (!Array.isArray(message)) continue;
    if (!/^execution_(success|error|interrupted)$/.test(String(message[0]))) continue;
    const stamp = (message[1] as { timestamp?: unknown } | undefined)?.timestamp;
    if (typeof stamp === "number" && Number.isFinite(stamp)) return stamp;
  }
  return undefined;
}

/** Queue entries are positional arrays; the prompt id sits at index 1. */
function promptIdOf(entry: unknown): string | undefined {
  return Array.isArray(entry) ? (entry[1] as string | undefined) : undefined;
}

/**
 * Resolve one prompt against an already-fetched queue, so a batch costs a
 * single /queue call rather than one per job.
 */
async function statusFor(
  promptId: string,
  queue: ComfyQueue,
): Promise<StatusPayload> {
  // History is authoritative: a finished prompt lands here whether it
  // succeeded or failed, so check it before the queue.
  let entry = await getHistoryEntry(promptId);

  // The first slice of a batched run, which finishes long before the run
  // does. The rest of the run carries on under prompt ids this app never saw,
  // so it is followed by what they share instead. See meta-batch.ts.
  if (entry && isUnfinishedBatch(entry) && !extractError(entry)) {
    const key = runKey(graphOf(entry.prompt));
    if (key) {
      const run = await followRun(key, queue);
      if (run.state === "running") {
        return { state: "running", queuePosition: null, outputs: [] };
      }
      if (run.state === "stopped") {
        return {
          state: "error",
          queuePosition: null,
          outputs: [],
          error: `The run stopped after ${run.passes} of its batches without finishing the file — it was interrupted, or ComfyUI restarted.`,
        };
      }
      // An interrupted pass records no error, only that it stopped — which
      // for a run is the end of it: nothing is queued behind it to finish.
      if (wasInterrupted(run.entry)) {
        return {
          state: "error",
          queuePosition: null,
          outputs: [],
          error: "The run was stopped partway through, so its file was never finished.",
        };
      }
      entry = run.entry;
    }
  }

  if (entry) {
    const failure = extractError(entry);
    const outputs = collectOutputs(entry);
    const briefs = briefsFrom(entry);
    const finishedAt = finishedAtOf(entry);

    if (failure) {
      return {
        state: "error",
        queuePosition: null,
        outputs: [],
        error: failure,
        briefs,
        finishedAt,
      };
    }

    // A graph whose only product is text — the music video's planner — is
    // finished when its director has written. Told apart by what was queued:
    // no node in it saves a file, so nothing was ever going to come back but
    // the brief.
    if (
      entry.status?.completed &&
      outputs.length === 0 &&
      Object.keys(briefs).length > 0 &&
      !savesAFile(entry)
    ) {
      return { state: "done", queuePosition: null, outputs: [], briefs, finishedAt };
    }

    // A completed prompt with nothing to show means the graph has no save
    // node wired to an output, which is a workflow bug worth naming.
    if (entry.status?.completed && outputs.length === 0) {
      return {
        state: "error",
        queuePosition: null,
        outputs: [],
        briefs,
        error:
          "The workflow finished but produced no file. Check that a save node (SaveVideo, SaveWEBM or VHS_VideoCombine) is connected in the graph.",
      };
    }

    if (outputs.length > 0) {
      return {
        state: "done",
        queuePosition: null,
        outputs: outputs.map((ref) => ({ ...ref, url: mediaUrl(ref) })),
        briefs,
        finishedAt,
      };
    }
  }

  if (queue.queue_running?.some((item) => promptIdOf(item) === promptId)) {
    return { state: "running", queuePosition: null, outputs: [] };
  }

  // In run order. ComfyUI hands the pending list back in its heap's order,
  // which is not the order it will run them in — with a dozen music video
  // scenes queued, the seventh read as twelfth. Each item leads with the number
  // it runs by.
  const pendingIndex =
    [...(queue.queue_pending ?? [])]
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .findIndex((item) => promptIdOf(item) === promptId);

  if (pendingIndex >= 0) {
    return { state: "queued", queuePosition: pendingIndex, outputs: [] };
  }

  // Not in history and not in the queue. Usually a race right after
  // submitting; the client keeps polling for a short grace period.
  return { state: "unknown", queuePosition: null, outputs: [] };
}

export async function GET(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const search = new URL(request.url).searchParams;
    const single = search.get("promptId");
    const batch = search.get("promptIds");

    if (!single && !batch) {
      throw new ParamError("promptId or promptIds is required.");
    }

    // One queue read serves every id in the request.
    const queue = await getQueue();

    if (single) {
      return Response.json(await statusFor(single, queue));
    }

    const ids = batch!
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, MAX_BATCH);

    const entries = await Promise.all(
      ids.map(async (id) => [id, await statusFor(id, queue)] as const),
    );

    return Response.json({ statuses: Object.fromEntries(entries) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Node classes that write a file: every core Save*, and VHS's combine. */
const SAVES = /^Save|^VHS_VideoCombine$/;

/** Whether the graph a history entry ran has anything in it that saves a file. */
function savesAFile(entry: ComfyHistoryEntry): boolean {
  const queued = Array.isArray(entry.prompt)
    ? (entry.prompt[2] as Record<string, { class_type?: string }> | undefined)
    : undefined;
  // Unknown is treated as "it does", which keeps the old, stricter answer.
  if (!queued) return true;
  return Object.values(queued).some((node) => SAVES.test(node.class_type ?? ""));
}

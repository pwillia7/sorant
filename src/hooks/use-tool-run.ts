"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "@/lib/client";

const POLL_MS = 1000;
/**
 * Polls that find the prompt in neither the queue nor the history before the
 * run is given up on. A just-queued prompt can miss both for a moment; this
 * long means ComfyUI restarted and forgot it.
 */
const UNKNOWN_GRACE = 20;

interface StatusPayload {
  state: "queued" | "running" | "done" | "error" | "unknown";
  outputs: Array<{ filename: string; subfolder?: string; type: string }>;
  error?: string;
}

/**
 * What the status line says. Kept apart from the run itself (`job` below):
 * the poll belongs to the prompt for as long as it lives, and the status moving
 * on to "saving" must not be what stops it.
 */
export type ToolStage = "idle" | "starting" | "waiting" | "working" | "saving";

export function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof ApiError || cause instanceof Error
    ? cause.message
    : fallback;
}

/**
 * One run of a graph that writes a picture back into a control — the Edit and
 * Create bars on a picture. Queued through /api/generate, polled like any
 * other run, then copied into ComfyUI's input directory by the same route the
 * clip hand-offs use, so what `onDone` receives is a reference a LoadImage
 * node can read, ready to drop into the slot.
 *
 * Not a job: it is not in the history, and nothing survives a reload. It is
 * seconds of work someone is watching, inside the control they started it from.
 */
export function useToolRun({
  onDone,
  noun,
}: {
  onDone: (ref: string) => void;
  /** What the run is called in its errors — "edit", "picture". */
  noun: string;
}) {
  const [stage, setStage] = useState<ToolStage>("idle");
  const [job, setJob] = useState<{ promptId: string; startedAt: number } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Read through refs so the poll below does not restart whenever the parent
  // renders a new callback.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);
  const nounRef = useRef(noun);
  useEffect(() => {
    nounRef.current = noun;
  }, [noun]);

  // The elapsed counter. Only while a run is going: a second's tick is all it
  // needs, and nothing at all when idle.
  useEffect(() => {
    if (!job) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [job]);

  const promptId = job?.promptId ?? null;

  useEffect(() => {
    if (!promptId) return;
    let stopped = false;
    let unknown = 0;
    const what = nounRef.current;

    const finish = (message: string | null) => {
      if (stopped) return;
      setJob(null);
      setStage("idle");
      setError(message);
    };

    const poll = async () => {
      if (stopped) return;
      try {
        const status = await api<StatusPayload>(
          `/api/status?${new URLSearchParams({ promptId })}`,
        );
        if (stopped) return;

        if (status.state === "done") {
          const output = status.outputs[0];
          if (!output) return finish(`The ${what} finished without a picture.`);
          setStage("saving");
          const { ref } = await api<{ ref: string }>("/api/remix", {
            method: "POST",
            body: JSON.stringify({
              filename: output.filename,
              subfolder: output.subfolder ?? "",
              type: output.type,
            }),
          });
          if (stopped) return;
          onDoneRef.current(ref);
          return finish(null);
        }
        if (status.state === "error") {
          return finish(status.error ?? `The ${what} failed.`);
        }
        if (status.state === "unknown" && ++unknown > UNKNOWN_GRACE) {
          return finish(`ComfyUI lost track of the ${what}. Try again.`);
        }
        // Queued means something was already rendering when this arrived: it
        // went in at the front, so the only thing ahead of it is that run.
        setStage(status.state === "queued" ? "waiting" : "working");
        setTimeout(poll, POLL_MS);
      } catch (cause) {
        finish(messageOf(cause, `Lost touch with the server during the ${what}.`));
      }
    };

    void poll();
    return () => {
      stopped = true;
    };
  }, [promptId]);

  const busy = stage !== "idle";

  /** Queues a run; `body` is /api/generate's. */
  const start = useCallback(
    async (body: Record<string, unknown>) => {
      setError(null);
      setStage("starting");
      try {
        const { promptId: queued } = await api<{ promptId: string }>(
          "/api/generate",
          { method: "POST", body: JSON.stringify(body) },
        );
        const startedAt = Date.now();
        setNow(startedAt);
        setStage("working");
        setJob({ promptId: queued, startedAt });
      } catch (cause) {
        setStage("idle");
        setError(messageOf(cause, `Could not start the ${nounRef.current}.`));
      }
    },
    [],
  );

  const cancel = useCallback(async () => {
    if (!promptId) return;
    // Back to idle straight away: the poll stops with the job, and whether
    // the cancel reached ComfyUI or not, nothing will be written to the slot.
    setJob(null);
    setStage("idle");
    await api("/api/cancel", {
      method: "POST",
      body: JSON.stringify({ promptId }),
    }).catch(() => undefined);
  }, [promptId]);

  const seconds = job
    ? Math.max(0, Math.round((now - job.startedAt) / 1000))
    : 0;

  return { stage, busy, error, seconds, start, cancel };
}

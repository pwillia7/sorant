"use client";

import { ScanEye } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { StatusPayload } from "@/app/api/status/route";
import { api, ApiError, withToken } from "@/lib/client";
import {
  CHECK_RECOVERED_COLOR,
  CHECK_SECONDS_PARAM,
  CHECK_START_PARAM,
  CHECK_TRACKED_COLOR,
  MASK_CHECK_ID,
  MAX_CHECK_SECONDS,
  PICK_PARAM,
  SUBJECT_BOX_PARAM,
} from "@/lib/workflows/subject-box";
import type { ParamValue } from "@/lib/workflows/types";
import { Button, Spinner } from "./button";

/**
 * "Check who SAM picks": the Character swap's SAM stage alone, run on the
 * stretch of clip a swap would start on, and the clip shown back with the mask
 * painted on it — green on who it tracked, red on frames "Find them again"
 * re-picked by the rule. See swap-mask-check.ts.
 *
 * Queued ahead of anything pending, like the picture editor's runs, and kept
 * out of the gallery: it is a look, not a result.
 */

const POLL_MS = 1500;
/** Polls with the prompt in neither queue nor history before giving up. */
const UNKNOWN_GRACE = 20;

/** The form's controls the check reads, by id. */
const READS = ["source_video", "prompt", PICK_PARAM, SUBJECT_BOX_PARAM, "lost_frames", "sam_threshold"] as const;

export function MaskCheck({
  values,
  start = 0,
  seconds = MAX_CHECK_SECONDS,
  disabled,
}: {
  /** The swap's values, with this shot's or segment's own pick laid over them. */
  values: Record<string, ParamValue | undefined>;
  /** Where the run SAM would look at starts, in seconds of the clip. */
  start?: number;
  /** How far to look; held to MAX_CHECK_SECONDS. */
  seconds?: number;
  disabled?: boolean;
}) {
  const [promptId, setPromptId] = useState<string | null>(null);
  const [stage, setStage] = useState<"idle" | "starting" | "waiting" | "running">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; key: string } | null>(null);

  const params: Record<string, ParamValue> = {};
  for (const id of READS) {
    const value = values[id];
    if (value !== undefined) params[id] = value;
  }
  params[CHECK_START_PARAM] = Math.max(0, Math.round(start * 1000) / 1000);
  params[CHECK_SECONDS_PARAM] = Math.min(MAX_CHECK_SECONDS, Math.max(0.5, Math.round(seconds * 1000) / 1000));
  const key = JSON.stringify(params);
  // A result for other settings says nothing about these ones.
  const stale = result !== null && result.key !== key;
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (!promptId) return;
    let stopped = false;
    let unknown = 0;
    const askedFor = keyRef.current;
    const finish = (message: string | null) => {
      if (stopped) return;
      setPromptId(null);
      setStage("idle");
      setError(message);
    };
    const poll = async () => {
      if (stopped) return;
      try {
        const status = await api<StatusPayload>(`/api/status?${new URLSearchParams({ promptId })}`);
        if (stopped) return;
        if (status.state === "done") {
          const output = status.outputs[0];
          if (!output) return finish("The check finished without a clip.");
          setResult({ url: withToken(output.url), key: askedFor });
          return finish(null);
        }
        if (status.state === "error") return finish(status.error ?? "The check failed.");
        if (status.state === "unknown" && ++unknown > UNKNOWN_GRACE) {
          return finish("ComfyUI lost track of the check. Try again.");
        }
        setStage(status.state === "queued" ? "waiting" : "running");
        setTimeout(poll, POLL_MS);
      } catch (cause) {
        finish(cause instanceof ApiError || cause instanceof Error ? cause.message : "Lost touch with the server.");
      }
    };
    void poll();
    return () => {
      stopped = true;
    };
  }, [promptId]);

  const run = async () => {
    setError(null);
    setStage("starting");
    try {
      const queued = await api<{ promptId: string }>("/api/generate", {
        method: "POST",
        body: JSON.stringify({ workflowId: MASK_CHECK_ID, params }),
      });
      setStage("running");
      setPromptId(queued.promptId);
    } catch (cause) {
      setStage("idle");
      setError(cause instanceof ApiError || cause instanceof Error ? cause.message : "Could not start the check.");
    }
  };

  const cancel = async () => {
    if (!promptId) return;
    const id = promptId;
    setPromptId(null);
    setStage("idle");
    await api("/api/cancel", { method: "POST", body: JSON.stringify({ promptId: id }) }).catch(() => undefined);
  };

  const busy = stage !== "idle";
  const recovering = (values.lost_frames ?? "leave") === "recover";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {busy ? (
          <>
            <span className="flex items-center gap-2 text-[12px] text-fg-muted" role="status">
              <Spinner className="size-3.5" />
              {stage === "waiting"
                ? "Waiting for the run in progress to finish…"
                : "SAM is finding and tracking them…"}
            </span>
            <Button variant="quiet" size="xs" onClick={() => void cancel()}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void run()}
            disabled={disabled || !values.source_video}
            title="Runs only SAM, at 0.5 MP: about half a minute, against many for the swap."
          >
            <ScanEye className="size-3.5 stroke-2" aria-hidden />
            {result ? "Check again" : "Check who SAM picks"}
          </Button>
        )}
        <span className="min-w-0 flex-1 text-[12px] text-fg-subtle">
          {Math.round(Math.min(MAX_CHECK_SECONDS, seconds))} s from {start > 0 ? `${start.toFixed(1)} s` : "the start"}
        </span>
      </div>
      {error ? (
        <p className="text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : null}
      {result ? (
        <div className={`flex flex-col gap-1.5 ${stale ? "opacity-50" : ""}`}>
          <video
            key={result.url}
            src={result.url}
            controls
            loop
            autoPlay
            muted
            playsInline
            className="max-h-[22rem] w-full rounded-lg bg-black object-contain"
            aria-label="The clip with the mask SAM made painted on it"
          />
          <p className="text-[12px] leading-relaxed text-fg-subtle">
            <span className="font-medium" style={{ color: CHECK_TRACKED_COLOR }}>Green</span> is who the swap would replace.
            {recovering ? (
              <>
                {" "}
                <span className="font-medium" style={{ color: CHECK_RECOVERED_COLOR }}>Red</span> is where SAM lost them and Find them again
                picked by the rule instead — red on anyone else is them swapped for those frames.
              </>
            ) : (
              " Unpainted frames are where SAM lost them; the swap leaves those as they are."
            )}
            {stale ? " These settings have changed since — check again." : ""}
          </p>
        </div>
      ) : null}
    </div>
  );
}

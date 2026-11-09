"use client";

import { Scissors, Undo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LongSwapController, ShotChoice } from "@/hooks/use-long-swap";
import {
  CUT_FPS,
  findCuts,
  MIN_SHOT_FRAMES,
  THUMB_HEIGHT,
  THUMB_WIDTH,
  tidyCuts,
  type Thumb,
} from "@/lib/scene-cuts";
import { CHAIN_OVER_SECONDS, shotSegments } from "@/lib/workflows/slices";
import { PICK_PARAM } from "@/lib/workflows/subject-box";
import { BoxPicker, inputVideoUrl } from "./ui/box-picker";
import { Button, Spinner } from "./ui/button";
import { Select } from "./ui/inputs";

/**
 * Before a Character swap runs: find the clip's camera cuts and say, shot by
 * shot, who to replace. See use-long-swap.ts (`planning`, `plan`) and
 * scene-cuts.ts.
 *
 * The cuts are found here, in the browser, from the clip ComfyUI already has:
 * a hidden <video> seeked frame by frame and drawn small to a canvas. That
 * needs nothing from the ComfyUI machine, and takes a few seconds a minute.
 */

/** A clip opened for reading frames off: seek, draw, read. */
interface OpenClip {
  /** The frame at `frame` on the 24 fps grid, drawn at width × height. */
  draw: (frame: number, width: number, height: number) => Promise<HTMLCanvasElement>;
  close: () => void;
}

async function openClip(url: string): Promise<OpenClip> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  await new Promise<void>((resolve, reject) => {
    video.addEventListener("loadeddata", () => resolve(), { once: true });
    video.addEventListener("error", () => reject(new Error("The clip could not be read.")), { once: true });
  });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("This browser cannot read frames off the clip.");
  const seek = (time: number) =>
    new Promise<void>((resolve, reject) => {
      if (Math.abs(video.currentTime - time) < 1e-6) return resolve();
      const timer = window.setTimeout(() => reject(new Error("The clip stopped answering.")), 15_000);
      video.addEventListener(
        "seeked",
        () => {
          window.clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      video.currentTime = time;
    });
  return {
    async draw(frame, width, height) {
      // Just past the frame's time, as the box picker seeks, so both show
      // the frame the swap reads there.
      await seek(Math.min(frame / CUT_FPS + 0.001, Math.max(0, video.duration - 0.001)));
      canvas.width = width;
      canvas.height = height;
      context.drawImage(video, 0, 0, width, height);
      return canvas;
    },
    close() {
      video.removeAttribute("src");
      video.load();
    },
  };
}

type Who = "form" | "largest" | "leftmost" | "rightmost" | "box" | "original";

const RULE_LABELS: Record<string, string> = {
  largest: "Biggest in frame",
  leftmost: "Furthest left",
  rightmost: "Furthest right",
};

interface Shot {
  /** Its first frame, at 24 fps. */
  start: number;
  who: Who;
  box: string;
}

const clock = (frame: number) => {
  const seconds = frame / CUT_FPS;
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(1).padStart(4, "0")}`;
};

function choiceOf(shot: Shot): ShotChoice {
  if (shot.who === "original") return { original: true };
  if (shot.who === "box") return shot.box ? { box: shot.box } : {};
  if (shot.who === "form") return {};
  return { pick: shot.who };
}

export function ShotPlanner({ swap }: { swap: LongSwapController }) {
  const project = swap.project!;
  const clip = String(project.values.source_video ?? "");
  const url = clip ? inputVideoUrl(clip) : "";
  const frames = Math.round(project.seconds * CUT_FPS);
  const [progress, setProgress] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [shots, setShots] = useState<Shot[] | null>(null);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [adding, setAdding] = useState("");
  const clipRef = useRef<OpenClip | null>(null);
  const formRule = RULE_LABELS[String(project.values[PICK_PARAM] ?? "largest")] ?? "the form's rule";

  // Find the cuts, once per clip.
  useEffect(() => {
    if (!url) {
      setFailure("The clip is not known, so its cuts cannot be found.");
      return;
    }
    const controller = new AbortController();
    let opened: OpenClip | null = null;
    void (async () => {
      try {
        opened = await openClip(url);
        clipRef.current = opened;
        const grab = async (frame: number): Promise<Thumb> => {
          const canvas = await opened!.draw(frame, THUMB_WIDTH, THUMB_HEIGHT);
          return canvas.getContext("2d")!.getImageData(0, 0, THUMB_WIDTH, THUMB_HEIGHT).data;
        };
        const found = await findCuts(frames, grab, {
          signal: controller.signal,
          onProgress: ({ fraction }) => setProgress(fraction),
        });
        const cuts = tidyCuts(found, frames);
        setShots([0, ...cuts].map((start) => ({ start, who: "form", box: "" })));
      } catch (cause) {
        if (controller.signal.aborted) return;
        setFailure(cause instanceof Error ? cause.message : "The clip's cuts could not be found.");
      }
    })();
    return () => {
      controller.abort();
      opened?.close();
      clipRef.current = null;
    };
  }, [url, frames]);

  // A small picture of each shot's first frame, as shots come and go.
  const starts = shots?.map((shot) => shot.start).join(",") ?? "";
  useEffect(() => {
    if (!starts) return;
    let cancelled = false;
    void (async () => {
      for (const start of starts.split(",").map(Number)) {
        if (cancelled || !clipRef.current) return;
        if (thumbs[start]) continue;
        try {
          const canvas = await clipRef.current.draw(start, 192, 108);
          const data = canvas.toDataURL("image/jpeg", 0.7);
          if (!cancelled) setThumbs((current) => ({ ...current, [start]: data }));
        } catch {
          return;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `thumbs` is read only to skip work already done.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starts]);

  const cuts = useMemo(() => (shots ?? []).slice(1).map((shot) => shot.start), [shots]);
  const segments = useMemo(() => shotSegments(project.seconds, cuts), [project.seconds, cuts]);
  const ends = (index: number) => shots?.[index + 1]?.start ?? frames;
  const swapped = shots
    ? segments.filter((segment) => {
        const owner = [...shots].reverse().find((shot) => shot.start <= segment.start);
        return owner?.who !== "original";
      }).length
    : 0;
  const unready = shots?.some((shot) => shot.who === "box" && !shot.box) ?? true;
  const oneRun = cuts.length === 0 && project.seconds <= CHAIN_OVER_SECONDS;

  const update = (index: number, change: Partial<Shot>) =>
    setShots((current) => current && current.map((shot, i) => (i === index ? { ...shot, ...change } : shot)));
  const merge = (index: number) => setShots((current) => current && current.filter((_, i) => i !== index));
  const addCut = () => {
    const seconds = Number(adding.replace(",", "."));
    if (!shots || !Number.isFinite(seconds)) return;
    const frame = Math.round(seconds * CUT_FPS);
    const tidy = tidyCuts([...cuts, frame], frames);
    if (!tidy.includes(frame)) {
      setFailure(`A cut there would leave a shot under ${MIN_SHOT_FRAMES / CUT_FPS} s.`);
      return;
    }
    setFailure(null);
    setShots(
      [0, ...tidy].map((start) => shots.find((shot) => shot.start === start) ?? { start, who: "form", box: "" }),
    );
    setAdding("");
  };

  const whoOptions = (index: number) => [
    { value: "form", label: index === 0 ? "As in the form" : `Form's rule: ${formRule.toLowerCase()}` },
    { value: "largest", label: RULE_LABELS.largest },
    { value: "leftmost", label: RULE_LABELS.leftmost },
    { value: "rightmost", label: RULE_LABELS.rightmost },
    { value: "box", label: "Draw a box" },
    ...(shots && shots.length > 1 ? [{ value: "original", label: "No one: leave it as it is" }] : []),
  ];

  if (!shots) {
    return (
      <div className="flex flex-col gap-3">
        {failure ? (
          <>
            <p className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-[13px] text-danger" role="alert">
              {failure}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="primary" onClick={() => void swap.plan([], [])}>
                Swap it as one shot
              </Button>
              <Button size="sm" variant="quiet" onClick={swap.clear}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-fg-muted" role="status">
            <Spinner className="size-3.5" />
            Finding the camera cuts… {Math.round(progress * 100)}%
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-fg-muted">
        {shots.length === 1
          ? "No camera cuts found: this is one shot."
          : `${shots.length} shots. Each starts fresh, so tracking never follows someone across a cut. Choose who to replace in each, or leave a shot without them as it is. A cut that is not one can be undone.`}
      </p>

      {failure ? (
        <p className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-[13px] text-danger" role="alert">
          {failure}
        </p>
      ) : null}

      <ol className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {shots.map((shot, index) => (
          <li
            key={shot.start}
            className={`flex min-w-0 flex-col gap-2 rounded-lg border border-border-default p-2 ${
              shot.who === "original" ? "bg-bg opacity-75" : "bg-bg-subtle"
            }`}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="text-[12px] font-medium text-fg">Shot {index + 1}</span>
              <span className="font-mono text-[11px] tabular-nums text-fg-subtle">
                {clock(shot.start)}–{clock(ends(index))}
              </span>
            </div>
            {shot.who === "box" ? null : thumbs[shot.start] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={thumbs[shot.start]}
                alt={`The first frame of shot ${index + 1}`}
                className="aspect-video w-full rounded bg-black object-contain"
              />
            ) : (
              <div className="aspect-video w-full rounded bg-black" />
            )}
            <label className="sr-only" htmlFor={`shot-${shot.start}-who`}>
              Who to replace in shot {index + 1}
            </label>
            <Select
              id={`shot-${shot.start}-who`}
              value={shot.who}
              onChange={(value) => update(index, { who: value as Who })}
              options={whoOptions(index)}
            />
            {shot.who === "box" && url ? (
              <BoxPicker
                src={url}
                time={shot.start / CUT_FPS}
                value={shot.box}
                onChange={(box) => update(index, { box })}
                label={`The first frame of shot ${index + 1}`}
              />
            ) : null}
            {index > 0 ? (
              <Button
                variant="quiet"
                size="xs"
                className="self-start"
                onClick={() => merge(index)}
                title={`Not a cut: joins shot ${index + 1} to shot ${index}, and it carries on from it.`}
              >
                <Undo2 className="size-3 shrink-0 stroke-2" aria-hidden /> Not a cut
              </Button>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-[12px] text-fg-subtle">
          Add a cut the search missed, at (seconds)
          <input
            inputMode="decimal"
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") addCut();
            }}
            placeholder="12.5"
            className="h-8 w-28 rounded-md border border-border-default bg-raised px-2 text-[13px] text-fg"
          />
        </label>
        <Button size="sm" onClick={addCut} disabled={!adding.trim()}>
          <Scissors className="size-3 shrink-0 stroke-2" aria-hidden /> Add cut
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border-default pt-3">
        <Button
          size="sm"
          variant="primary"
          disabled={unready || swapped === 0}
          loading={swap.sending}
          onClick={() => void swap.plan(cuts, shots.map(choiceOf))}
        >
          Start the swap
        </Button>
        <span className="text-[12px] text-fg-subtle">
          {unready
            ? "Draw the box for each shot set to one."
            : swapped === 0
              ? "Every shot is left as it is."
              : oneRun
                ? "One run."
                : `${swapped} run${swapped === 1 ? "" : "s"} to swap${
                    segments.length > swapped ? `, ${segments.length - swapped} copied as they are` : ""
                  }.`}
        </span>
        <Button size="sm" variant="quiet" className="ml-auto" onClick={swap.clear}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

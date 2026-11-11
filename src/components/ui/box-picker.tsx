"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { withToken } from "@/lib/client";
import {
  boxValue,
  CHECK_RECOVERED_COLOR,
  CHECK_TRACKED_COLOR,
  MAX_PICK_POINTS,
  parseBox,
  parsePick,
  pointsValue,
  type PickPoint,
  type SubjectBox,
} from "@/lib/workflows/subject-box";
import { Button } from "./button";
import { Segmented } from "./inputs";

/**
 * Point out on one frame of a clip who the Character swap should replace:
 * clicks on them and on anyone to leave out, or a box drawn around them.
 *
 * The frame is the clip itself, paused at `time`, in a wrapper sized to its
 * shape so a point in the wrapper is the same fraction of the frame — no
 * letterbox to subtract. A pick is kept as fractions of the frame with the
 * frame's size (subject-box.ts); the graph turns it into pixels.
 *
 * Points or a box, not both: no SAM node takes the two together and keeps
 * both through its refinement, so choosing one tool clears the other's pick.
 */

type Tool = "in" | "out" | "box";

/** A click this near an existing point takes it away, as a fraction of the frame. */
const NEAR = 0.03;

/** A clip in ComfyUI's input folder, as a URL a <video> can load. */
export function inputVideoUrl(ref: string): string {
  return withToken(
    `/api/media?${new URLSearchParams({
      filename: ref.split("/").pop() ?? ref,
      subfolder: ref.includes("/") ? ref.slice(0, ref.lastIndexOf("/")) : "",
      type: "input",
    })}`,
  );
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

export function BoxPicker({
  src,
  time = 0,
  value,
  onChange,
  disabled,
  label = "Frame to draw on",
}: {
  /** The clip, as a URL. */
  src: string;
  /** Which moment of it, in seconds. */
  time?: number;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [draft, setDraft] = useState<SubjectBox | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const pick = parsePick(value);
  const [tool, setTool] = useState<Tool>(() => (parseBox(value) ? "box" : "in"));
  const box = tool === "box" ? (draft ?? parseBox(value)) : null;
  const include: PickPoint[] = pick?.include ?? [];
  const exclude: PickPoint[] = pick?.exclude ?? [];

  // A new clip or moment: measure again and seek. Just past the time, so the
  // browser paints that frame rather than the one before it.
  // A new moment of a clip already loaded fires no loadedmetadata, so it is
  // measured here; a new clip is measured when its metadata comes.
  useEffect(() => {
    const element = video.current;
    if (element && element.readyState >= 1 && element.videoWidth && element.videoHeight) {
      setSize({ w: element.videoWidth, h: element.videoHeight });
      element.currentTime = time + 0.001;
    } else setSize(null);
  }, [src, time]);

  // A box drawn on another clip, or another moment, is around nobody here.
  const shown = useRef(`${src}@${time}`);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  useEffect(() => {
    const key = `${src}@${time}`;
    if (shown.current === key) return;
    shown.current = key;
    if (latest.current.value) latest.current.onChange("");
  }, [src, time]);

  const at = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
    };
  };

  const choose = (next: Tool) => {
    // Points and a box do not mix: going from one to the other starts over.
    if ((next === "box") !== (tool === "box") && value) onChange("");
    setTool(next);
  };

  const click = (point: { x: number; y: number }) => {
    if (!size) return;
    const near = (p: PickPoint) => Math.hypot(p[0] - point.x, p[1] - point.y) < NEAR;
    let nextIn = include;
    let nextOut = exclude;
    if (include.some(near) || exclude.some(near)) {
      nextIn = include.filter((p) => !near(p));
      nextOut = exclude.filter((p) => !near(p));
    } else if (tool === "in" && include.length < MAX_PICK_POINTS) {
      nextIn = [...include, [point.x, point.y]];
    } else if (tool === "out" && exclude.length < MAX_PICK_POINTS) {
      nextOut = [...exclude, [point.x, point.y]];
    }
    onChange(pointsValue(nextIn, nextIn.length ? nextOut : [], size.w, size.h));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || !size || event.button !== 0) return;
    if (tool !== "box") {
      click(at(event));
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = at(event);
    setDraft({ ...start.current, w: 0, h: 0, sw: size.w, sh: size.h });
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!start.current || !size) return;
    const point = at(event);
    setDraft({
      x: Math.min(start.current.x, point.x),
      y: Math.min(start.current.y, point.y),
      w: Math.abs(point.x - start.current.x),
      h: Math.abs(point.y - start.current.y),
      sw: size.w,
      sh: size.h,
    });
  };
  const onPointerUp = () => {
    if (!start.current) return;
    start.current = null;
    // A click rather than a drag leaves the box as it was.
    if (draft && draft.w >= 0.02 && draft.h >= 0.02) onChange(boxValue(draft));
    setDraft(null);
  };

  const ratio = size ? size.w / size.h : 16 / 9;

  const hint = !size
    ? "Loading the frame…"
    : tool === "box"
      ? box
        ? "Whoever is in the box is replaced. Drag again to redraw it — around all of them, head to feet."
        : "Drag a box around the person to replace, head to feet."
      : tool === "in"
        ? include.length
          ? "Click more of them — face, body, legs — for a surer mask. Click a dot to take it away."
          : "Click on the person to replace."
        : "Click on anyone SAM should leave out. Click a dot to take it away.";

  return (
    <div className="flex flex-col gap-2">
      <Segmented
        label="How to point them out"
        value={tool}
        onChange={choose}
        options={[
          { value: "in", label: "Click on them" },
          {
            value: "out",
            label: "Leave someone out",
            disabled: include.length === 0,
            title: "After clicking on who to replace: click anyone else the mask takes in.",
          },
          { value: "box", label: "Draw a box" },
        ]}
      />
      <div className="flex justify-center rounded-lg bg-black">
        <div
          className="relative overflow-hidden"
          // As wide as it can be, but never taller than 22rem: the width is
          // what is capped, so the wrapper keeps the frame's shape.
          style={{ aspectRatio: String(ratio), width: `min(100%, calc(22rem * ${ratio}))` }}
        >
          <video
            ref={video}
            src={src}
            muted
            playsInline
            preload="auto"
            aria-label={label}
            onLoadedMetadata={(event) => {
              const element = event.currentTarget;
              if (element.videoWidth && element.videoHeight) {
                setSize({ w: element.videoWidth, h: element.videoHeight });
              }
              element.currentTime = time + 0.001;
            }}
            className="absolute inset-0 h-full w-full object-fill"
          />
          <div
            role="presentation"
            className={`absolute inset-0 touch-none select-none ${disabled || !size ? "" : tool === "box" ? "cursor-crosshair" : "cursor-pointer"}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {include.map(([x, y], i) => (
              <span
                key={`in-${i}`}
                className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                style={{ left: `${x * 100}%`, top: `${y * 100}%`, backgroundColor: CHECK_TRACKED_COLOR }}
              />
            ))}
            {exclude.map(([x, y], i) => (
              <span
                key={`out-${i}`}
                className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow"
                style={{ left: `${x * 100}%`, top: `${y * 100}%`, backgroundColor: CHECK_RECOVERED_COLOR }}
              />
            ))}
            {box ? (
              <div
                className="pointer-events-none absolute rounded-sm border-2 border-accent bg-accent/15 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]"
                style={{
                  left: `${box.x * 100}%`,
                  top: `${box.y * 100}%`,
                  width: `${box.w * 100}%`,
                  height: `${box.h * 100}%`,
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-fg-subtle">
        <span className="min-w-0 flex-1">{hint}</span>
        {pick ? (
          <Button
            variant="quiet"
            size="xs"
            onClick={() => {
              onChange("");
              if (tool === "out") setTool("in");
            }}
            disabled={disabled}
          >
            {pick.box ? "Clear box" : "Clear points"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

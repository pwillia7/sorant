"use client";

import { ChevronLeft, ChevronRight, Download, Expand, Maximize, Pause, Play, Volume2, VolumeX, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactEventHandler, type SyntheticEvent } from "react";
import { buttonClasses } from "./button";

/**
 * A small clip you can actually use: the browser's own controls are a fixed
 * size, so on a card-sized video they bury the picture and shrink the timeline
 * to a sliver. This draws its own — click anywhere to play or pause, a thin
 * timeline, and mute, fullscreen and open-big buttons in the corner — and opens
 * the clip in a large viewer (ClipViewer) with the browser's controls, where
 * they fit.
 *
 * Hovering plays it silently, like the gallery; pressing play plays it with
 * sound unless it has been muted.
 */

export type ClipItem = {
  /** Already carrying the access token. */
  url: string;
  title: string;
  subtitle?: string;
  /** Filename for the viewer's Download; no Download without it. */
  download?: string;
};

type WebkitVideo = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/** Fullscreen on the element where the platform allows it, else iOS's own player. */
export function enterFullscreen(video: HTMLVideoElement | null) {
  if (!video) return;
  if (video.requestFullscreen) {
    void video.requestFullscreen().catch(() => (video as WebkitVideo).webkitEnterFullscreen?.());
  } else {
    (video as WebkitVideo).webkitEnterFullscreen?.();
  }
}

const clockOf = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

const cornerButton =
  "grid size-7 place-items-center rounded-md bg-black/60 text-white transition-colors hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-white";

export function ClipPlayer({
  item,
  siblings,
  className = "",
  videoClassName = "size-full object-contain",
  loop = false,
  preload = "metadata",
  onLoadedMetadata,
  onError,
}: {
  item: ClipItem;
  /** The clips the viewer steps through, this one among them. */
  siblings?: ClipItem[];
  /** The frame: size and shape. The video fills it. */
  className?: string;
  videoClassName?: string;
  loop?: boolean;
  preload?: "metadata" | "auto" | "none";
  onLoadedMetadata?: ReactEventHandler<HTMLVideoElement>;
  onError?: ReactEventHandler<HTMLVideoElement>;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  /** Played on purpose, not as a hover preview. */
  const [chosen, setChosen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [viewing, setViewing] = useState(false);

  const play = (withSound: boolean) => {
    const element = video.current;
    if (!element) return;
    element.muted = withSound ? muted : true;
    void element.play().catch(() => {
      // Sound refused without a gesture the browser counts: play silently.
      element.muted = true;
      setMuted(true);
      void element.play().catch(() => undefined);
    });
  };

  const toggle = () => {
    const element = video.current;
    if (!element) return;
    if (element.paused || !chosen) {
      setChosen(true);
      play(true);
    } else {
      element.pause();
    }
  };

  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    if (video.current && chosen) video.current.muted = next;
  };

  const open = () => {
    video.current?.pause();
    setChosen(false);
    setViewing(true);
  };

  const list = siblings?.some((entry) => entry.url === item.url) ? siblings : [item];

  return (
    <>
      <div
        className={`group relative overflow-hidden bg-black ${className}`}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse" && video.current?.paused && !chosen) play(false);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType !== "mouse" || chosen || !video.current) return;
          video.current.pause();
        }}
      >
        <video
          ref={video}
          src={item.url}
          muted
          loop={loop || !chosen}
          playsInline
          preload={preload}
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => {
            setPlaying(false);
            setChosen(false);
          }}
          onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
          onDurationChange={(event) => setDuration(event.currentTarget.duration)}
          onLoadedMetadata={(event: SyntheticEvent<HTMLVideoElement>) => {
            setDuration(event.currentTarget.duration);
            onLoadedMetadata?.(event);
          }}
          onError={onError}
          aria-label={item.title}
          className={`block cursor-pointer ${videoClassName}`}
        />

        {/* Big play mark while stopped, so it reads as a video at a glance;
            gone while it plays, the hover preview included. */}
        {!playing ? (
          <span className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="grid size-10 place-items-center rounded-full bg-black/55 text-white opacity-90">
              <Play className="ml-0.5 size-5 fill-current" aria-hidden="true" />
            </span>
          </span>
        ) : null}

        <div className="absolute right-1.5 top-1.5 flex gap-1 opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100">
          <button type="button" onClick={toggleMute} className={cornerButton} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>
            {muted ? <VolumeX className="size-3.5" aria-hidden="true" /> : <Volume2 className="size-3.5" aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={() => {
              setChosen(true);
              play(true);
              enterFullscreen(video.current);
            }}
            className={cornerButton}
            aria-label="Fullscreen"
            title="Fullscreen"
          >
            <Maximize className="size-3.5" aria-hidden="true" />
          </button>
          <button type="button" onClick={open} className={cornerButton} aria-label={`Open ${item.title} large`} title="Open large">
            <Expand className="size-3.5" aria-hidden="true" />
          </button>
        </div>

        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-1.5 pb-1 pt-3 opacity-100 transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-hover:opacity-100">
          <button
            type="button"
            onClick={toggle}
            className="grid size-6 shrink-0 place-items-center rounded text-white hover:bg-white/15"
            aria-label={chosen && playing ? "Pause" : "Play"}
          >
            {chosen && playing ? <Pause className="size-3.5 fill-current" aria-hidden="true" /> : <Play className="size-3.5 fill-current" aria-hidden="true" />}
          </button>
          <input
            type="range"
            min={0}
            max={duration || 0}
            step={0.01}
            value={Math.min(time, duration || 0)}
            onChange={(event) => {
              if (video.current) video.current.currentTime = Number(event.target.value);
            }}
            aria-label="Position"
            className="h-1 min-w-0 flex-1 cursor-pointer accent-white"
          />
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-white/85">
            {clockOf(time)}/{clockOf(duration)}
          </span>
        </div>
      </div>
      {viewing ? (
        <ClipViewer items={list} start={Math.max(0, list.findIndex((entry) => entry.url === item.url))} onClose={() => setViewing(false)} />
      ) : null}
    </>
  );
}

/**
 * A clip at the size of the screen, with the browser's controls — they fit
 * here — and the clips beside it a step away (← and →, or the arrows).
 */
export function ClipViewer({ items, start, onClose }: { items: ClipItem[]; start: number; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [index, setIndex] = useState(start);
  const item = items[index] ?? items[0];
  const step = (by: number) => setIndex((current) => Math.min(items.length - 1, Math.max(0, current + by)));

  useEffect(() => {
    const element = dialog.current;
    // No close() on cleanup: its close event would arrive after StrictMode's
    // remount and shut the viewer at once. Unmounting takes it off the top layer.
    if (element && !element.open) element.showModal();
  }, []);

  if (!item) return null;
  const many = items.length > 1;

  return (
    <dialog
      ref={dialog}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) onClose();
      }}
      onKeyDown={(event) => {
        // The video's own controls use the arrows to seek once focused.
        if (event.target instanceof HTMLVideoElement || event.target instanceof HTMLInputElement) return;
        if (event.key === "ArrowLeft") step(-1);
        if (event.key === "ArrowRight") step(1);
      }}
      aria-label={item.title}
      className="m-auto max-h-none max-w-none bg-transparent p-0 text-fg backdrop:bg-black/85"
    >
      <div className="flex w-[min(64rem,calc(100vw-1rem))] flex-col gap-2 rounded-lg border border-border-strong bg-surface p-2 sm:p-3">
        <header className="flex items-center gap-2 px-1">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[14px] font-semibold text-fg">{item.title}</h2>
            {item.subtitle ? <p className="truncate font-mono text-[11px] text-fg-subtle">{item.subtitle}</p> : null}
          </div>
          {many ? (
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
              {index + 1} of {items.length}
            </span>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="grid size-8 shrink-0 place-items-center rounded-md text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </header>
        <video
          ref={video}
          key={item.url}
          src={item.url}
          controls
          autoPlay
          playsInline
          className="max-h-[calc(100dvh-9rem)] w-full rounded-md bg-black object-contain"
        />
        <footer className="flex flex-wrap items-center gap-2 px-1">
          {many ? (
            <>
              <button type="button" onClick={() => step(-1)} disabled={index === 0} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                <ChevronLeft className="size-3.5" aria-hidden="true" /> Previous
              </button>
              <button
                type="button"
                onClick={() => step(1)}
                disabled={index === items.length - 1}
                className={buttonClasses({ variant: "secondary", size: "sm" })}
              >
                Next <ChevronRight className="size-3.5" aria-hidden="true" />
              </button>
            </>
          ) : null}
          <span className="flex-1" />
          <button type="button" onClick={() => enterFullscreen(video.current)} className={buttonClasses({ variant: "quiet", size: "sm" })}>
            <Maximize className="size-3.5" aria-hidden="true" /> Fullscreen
          </button>
          {item.download ? (
            <a href={item.url} download={item.download} className={buttonClasses({ variant: "secondary", size: "sm" })}>
              <Download className="size-3.5" aria-hidden="true" /> Download
            </a>
          ) : null}
        </footer>
      </div>
    </dialog>
  );
}

"use client";

import { useState } from "react";
import type { MusicVideoController } from "@/hooks/use-music-video";
import { withToken } from "@/lib/client";
import type { Job } from "@/lib/jobs";
import {
  MUSIC_VIDEO_FRAME_RATES,
  MUSIC_VIDEO_UPSCALE_SIZES,
} from "@/lib/music-video/project";
import { clock } from "@/lib/music-video/scenes";
import { Badge, Dot, Panel, PanelHeader } from "./ui/panel";
import { Button, buttonClasses, Spinner } from "./ui/button";
import { TextArea } from "./ui/inputs";

/**
 * The music video's own stage: the scene list, each scene's take as it
 * arrives, and the finished video.
 *
 * Shown above the usual stage rather than in place of it. A scene is a job,
 * so the stage and the history below still show any one of them in full —
 * this is the view of all of them together.
 */

const STEP_HINT: Record<MusicVideoController["step"], string> = {
  idle: "Add the song and an idea, then plan the video.",
  cutting: "Cutting the song on its beats…",
  planning: "Writing a scene for every cut…",
  planned: "Read the scenes through and change any you like, then render them.",
  rendering: "Rendering — every scene is queued, and they run one after another.",
  rendered: "Every scene is done. Redo any you do not like, then join them.",
  stitching: "Joining the scenes and laying the song over them…",
  done: "Finished.",
};

export function MusicVideoPanel({ video }: { video: MusicVideoController }) {
  const { project, step } = video;
  const scenes = project?.scenes ?? [];
  // The saved file, not the previews of what it was made from: every scene's
  // loader and trim reports a video of its own in the same run.
  const finalUrl = joinedUrl(video.final);
  const upscaledUrl = joinedUrl(video.upscaledFinal);
  const allRendered = step === "rendered" || step === "done";
  const upscaleRemaining = scenes.filter((scene) => {
    const job = video.upscaleFor(scene);
    return !job || ["error", "cancelled", "unknown"].includes(job.phase);
  }).length;
  const jobs = scenes.map(video.jobFor);
  const [chosenSize, setChosenSize] = useState<number>(
    MUSIC_VIDEO_UPSCALE_SIZES[0].px,
  );
  /**
   * Each scene clip's shorter side, by URL, read off the previews below as
   * their metadata loads. By URL so a redone scene is measured afresh.
   */
  const [shorterSides, setShorterSides] = useState<Record<string, number>>({});
  const measure = (url: string, element: HTMLVideoElement) => {
    const side = Math.min(element.videoWidth, element.videoHeight);
    if (side > 0 && shorterSides[url] !== side) {
      setShorterSides((current) => ({ ...current, [url]: side }));
    }
  };
  const clipUrls = scenes
    .map((_, index) => sceneClip(jobs[index])?.url)
    .filter((url): url is string => Boolean(url));
  const measured = clipUrls
    .map((url) => shorterSides[url])
    .filter((side): side is number => side !== undefined);
  // The smallest scene decides: a size is worth offering while it would make
  // any scene bigger. Unknown until a preview has loaded, and then offered.
  const smallestSide = measured.length > 0 ? Math.min(...measured) : undefined;
  const enlarges = (px: number) => smallestSide === undefined || px > smallestSide;
  const offered = MUSIC_VIDEO_UPSCALE_SIZES.filter(({ px }) => enlarges(px));
  // Once a scene has gone to the upscale, the rest follow it at its size.
  const upscaleSize =
    project?.upscaleSize ??
    (enlarges(chosenSize) ? chosenSize : (offered[0]?.px ?? chosenSize));
  const [chosenRate, setChosenRate] = useState<number>(
    MUSIC_VIDEO_FRAME_RATES[0].multiplier,
  );
  // Fixed with the size once a scene has gone, so the rest match it.
  const upscaleRate = project?.upscaleFrameRate ?? (project?.upscaleSize ? 1 : chosenRate);
  const upscaleTime = (px: number, multiplier = upscaleRate) => {
    const size =
      MUSIC_VIDEO_UPSCALE_SIZES.find((option) => option.px === px) ??
      MUSIC_VIDEO_UPSCALE_SIZES[0];
    const frameRate =
      MUSIC_VIDEO_FRAME_RATES.find((option) => option.multiplier === multiplier) ??
      MUSIC_VIDEO_FRAME_RATES[0];
    const rate = size.secondsPerSecond * frameRate.timeFactor[size.px];
    const hours = ((project?.songSeconds ?? 0) * rate) / 3600;
    return hours < 1
      ? `${Math.max(1, Math.round(hours * 60))} min`
      : `${hours.toFixed(1)} h`;
  };
  const finished = jobs.filter((job) => job?.phase === "done").length;
  const unrendered = scenes.filter((scene, index) => {
    const job = jobs[index];
    return !scene.promptId || (job && ["error", "cancelled", "unknown"].includes(job.phase));
  }).length;

  return (
    <Panel padded>
      <PanelHeader
        title="Music video"
        hint={STEP_HINT[step]}
        action={
          project ? (
            <Button
              variant="quiet"
              size="xs"
              onClick={video.clear}
              disabled={step === "cutting"}
              title="Forget this plan. Its scenes stay in the history."
            >
              Start over
            </Button>
          ) : null
        }
      />

      {video.error ? (
        <div
          className="mb-4 flex items-start gap-3 rounded-lg border border-danger/40
            bg-danger/5 p-3 text-[13px] leading-relaxed text-danger"
        >
          <span className="min-w-0 flex-1">{video.error}</span>
          <Button variant="danger" size="xs" className="shrink-0" onClick={video.dismissError}>
            Dismiss
          </Button>
        </div>
      ) : null}
      {video.recoveryNote ? (
        <p className="mb-4 text-[13px] leading-relaxed text-fg-subtle">{video.recoveryNote}</p>
      ) : null}

      {step === "cutting" || step === "planning" ? (
        <p className="flex items-center gap-2 text-[13px] text-fg-muted">
          <Spinner className="size-3.5" />
          {step === "cutting"
            ? "Finding the beats in the song."
            : `${scenes.length} scenes, ${clock(project?.songSeconds ?? 0)} of song.`}
        </p>
      ) : null}

      {upscaledUrl ? (
        <FinishedVideo
          url={upscaledUrl}
          label="Upscaled"
          download={`music_video_${project?.id ?? ""}_upscaled.mp4`}
        />
      ) : null}
      {finalUrl ? (
        <FinishedVideo
          url={finalUrl}
          label={upscaledUrl ? "Original" : undefined}
          download={`music_video_${project?.id ?? ""}.mp4`}
          compact={Boolean(upscaledUrl)}
        />
      ) : null}

      {scenes.some((scene) => scene.shot) ? (
        <>
          {/*
            How the people in the pictures look, once for every scene. Only
            when the planner wrote one: without pictures there is nobody to
            hold, and a project planned before this existed has none.
          */}
          {project?.look !== undefined && project.values.reference_image_1 ? (
            <div className="mb-3 rounded-lg border border-border-default p-3">
              <label
                htmlFor="music-video-look"
                className="mb-1 block text-[12px] font-medium text-fg"
              >
                How they look in every scene
              </label>
              <TextArea
                id="music-video-look"
                value={project.look}
                rows={3}
                maxLength={2000}
                onChange={(value) => video.editLook(value)}
              />
              <p className="mt-1 text-[12px] leading-snug text-fg-subtle">
                Given word for word to every scene, so the costume holds across
                the cuts. Edits apply to scenes rendered from now on.
              </p>
            </div>
          ) : null}
          <ol className="flex flex-col gap-3">
            {scenes.map((scene, index) => {
              const job = jobs[index];
              const clip = sceneClip(job);
              return (
                <li
                  key={`${scene.start}-${index}`}
                  className="rounded-lg border border-border-default p-3"
                >
                  <div className="mb-2 flex items-center gap-2 text-[12px] text-fg-muted">
                    <span className="font-medium text-fg">Scene {index + 1}</span>
                    <span className="font-mono">
                      {clock(scene.start)}–{clock(scene.end)}
                    </span>
                    <span>{(scene.end - scene.start).toFixed(1)} s</span>
                    {scene.part ? (
                      <span
                        title="Where the planner thinks this scene falls in the song, and whether anyone sings in it. It cannot hear the song, so it is a guess from the lyrics and the loudness."
                      >
                        {scene.part}
                        {scene.sings ? " · sings" : ""}
                      </span>
                    ) : null}
                    <SceneStatus job={job} />
                    {job && (job.phase === "done" || ["error", "cancelled", "unknown"].includes(job.phase)) ? (
                      <Button
                        variant="quiet"
                        size="xs"
                        className="ml-auto"
                        onClick={() => void video.redo(index)}
                        title="Render another take on a fresh seed, with the shot as it reads now. The takes you have stay below to pick from."
                      >
                        Redo
                      </Button>
                    ) : null}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <div className="min-w-0 flex-1">
                      <TextArea
                        id={`scene-${index}`}
                        value={scene.shot}
                        rows={3}
                        maxLength={2000}
                        // Editable except while its take is in the queue: the
                        // run has already been handed what it said.
                        disabled={job?.phase === "queued" || job?.phase === "running"}
                        onChange={(value) => video.editShot(index, value)}
                      />
                    </div>
                    {clip ? (
                      <video
                        src={withToken(clip.url)}
                        onLoadedMetadata={(event) => measure(clip.url, event.currentTarget)}
                        muted
                        loop
                        playsInline
                        controls
                        preload="metadata"
                        className="w-full rounded-md border border-border-default bg-black sm:w-48"
                      />
                    ) : null}
                  </div>
                  <TakePicker
                    takes={video.takesFor(index)}
                    using={scene.promptId}
                    onPick={(promptId) => video.pickTake(index, promptId)}
                  />
                  {job?.phase === "error" && job.error ? (
                    <p className="mt-2 text-[12px] leading-relaxed text-danger">{job.error}</p>
                  ) : null}
                </li>
              );
            })}
          </ol>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            {video.lostCount > 0 ? (
              <Button
                variant="primary"
                disabled={video.recovering}
                onClick={() => void video.recover()}
                title="This device lost contact with the ComfyUI machine while these scenes were queued, so they may have finished anyway. Looks for their clips on the machine before anything is rendered again."
              >
                {video.recovering
                  ? "Looking…"
                  : `Find ${video.lostCount === 1 ? "the lost scene" : `the ${video.lostCount} lost scenes`} on the machine`}
              </Button>
            ) : null}
            {unrendered > 0 ? (
              <Button
                variant={video.lostCount > 0 ? "secondary" : "primary"}
                onClick={() => void video.renderAll()}
              >
                {finished > 0 || unrendered < scenes.length
                  ? `Render the ${unrendered} remaining`
                  : `Render ${scenes.length} scenes`}
              </Button>
            ) : null}
            {step === "rendered" || step === "done" ? (
              <Button
                variant={step === "done" ? "secondary" : "primary"}
                onClick={() => void video.stitch()}
              >
                Join into the video
              </Button>
            ) : null}
            {allRendered && !video.upscale.active && !video.upscale.joining && !upscaledUrl ? (
              !project?.upscaleSize && offered.length === 0 ? (
                <span className="text-[12px] text-fg-subtle">
                  Already {smallestSide} px on its shorter side, so upscaling would not
                  make it any bigger.
                </span>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={() => void video.upscaleAll(upscaleSize, upscaleRate)}
                    title={`Upscales every scene to ${upscaleSize} px${upscaleRate > 1 ? ` at ${24 * upscaleRate} fps` : ""}, then joins the upscaled scenes into a second video. Roughly ${upscaleTime(upscaleSize)} for this song.`}
                  >
                    {upscaleRemaining < scenes.length
                      ? `Upscale the ${upscaleRemaining} remaining`
                      : "Upscale the video"}
                  </Button>
                  {project?.upscaleSize ? (
                    <span className="text-[12px] text-fg-subtle">
                      at {project.upscaleSize} px
                      {upscaleRate > 1 ? `, ${24 * upscaleRate} fps` : ""}, like the rest
                    </span>
                  ) : (
                    <>
                    <div
                      role="radiogroup"
                      aria-label="Upscale size"
                      className="flex rounded-md border border-border-default bg-bg p-0.5"
                    >
                      {MUSIC_VIDEO_UPSCALE_SIZES.map(({ px }) => {
                        const selected = px === upscaleSize;
                        const useful = enlarges(px);
                        return (
                          <button
                            key={px}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={!useful}
                            title={
                              useful
                                ? undefined
                                : `The scenes are already ${smallestSide} px on their shorter side`
                            }
                            onClick={() => setChosenSize(px)}
                            className={`rounded px-3 py-1 text-[12px] font-medium transition-colors duration-150
                              disabled:cursor-not-allowed disabled:opacity-40
                              ${
                                selected
                                  ? "bg-accent-subtle text-fg"
                                  : "text-fg-subtle enabled:hover:text-fg"
                              }`}
                          >
                            {px === 2160 ? "4K" : `${px} px`}
                            <span className="ml-1.5 font-normal text-fg-subtle">
                              ~{upscaleTime(px)}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    <div
                      role="radiogroup"
                      aria-label="Upscale frame rate"
                      className="flex rounded-md border border-border-default bg-bg p-0.5"
                    >
                      {MUSIC_VIDEO_FRAME_RATES.map(({ multiplier, label }) => {
                        const selected = multiplier === upscaleRate;
                        return (
                          <button
                            key={multiplier}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            title={
                              multiplier > 1
                                ? "Makes a new frame between every pair with RIFE, for smoother motion. The song is unchanged."
                                : "Keeps H3's own frames."
                            }
                            onClick={() => setChosenRate(multiplier)}
                            className={`rounded px-3 py-1 text-[12px] font-medium transition-colors duration-150
                              ${
                                selected
                                  ? "bg-accent-subtle text-fg"
                                  : "text-fg-subtle hover:text-fg"
                              }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                    </>
                  )}
                </div>
              )
            ) : null}
            {video.upscale.active || video.upscale.joining ? (
              <span className="flex items-center gap-2 text-[13px] text-fg-muted">
                <Spinner className="size-3.5" />
                {video.upscale.joining
                  ? "Joining the upscaled scenes"
                  : `Upscaling: ${video.upscale.done} of ${scenes.length} scenes`}
              </span>
            ) : null}
            {step === "stitching" ? (
              <span className="flex items-center gap-2 text-[13px] text-fg-muted">
                <Spinner className="size-3.5" /> Joining {scenes.length} scenes
              </span>
            ) : null}
            <span className="text-[12px] text-fg-subtle">
              {finished} of {scenes.length} scenes rendered
            </span>
          </div>
        </>
      ) : null}
    </Panel>
  );
}

function SceneStatus({ job }: { job: Job | undefined }) {
  if (!job) return <Badge>not rendered</Badge>;
  switch (job.phase) {
    case "queued":
      return (
        <Badge>
          <Dot /> queued{job.queuePosition ? ` · ${job.queuePosition} ahead` : ""}
        </Badge>
      );
    case "running":
      return (
        <Badge tone="accent">
          <Dot tone="accent" pulse /> rendering
        </Badge>
      );
    case "done":
      return <Badge tone="success">done</Badge>;
    case "cancelled":
      return <Badge tone="warning">cancelled</Badge>;
    default:
      return <Badge tone="danger">failed</Badge>;
  }
}

/**
 * A scene's takes as thumbnails, the one in use ringed — the same strip the
 * photo editor keeps its versions in. Clicking one uses it. Nothing is shown
 * until there is a second take to choose.
 */
function TakePicker({
  takes,
  using,
  onPick,
}: {
  takes: Job[];
  using: string | undefined;
  onPick: (promptId: string) => void;
}) {
  if (takes.length < 2) return null;
  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="shrink-0 text-[11px] text-fg-subtle">Takes</span>
      <div
        className="flex min-w-0 gap-1.5 overflow-x-auto"
        role="group"
        aria-label="Takes of this scene"
      >
        {takes.map((take, index) => {
          const clip = sceneClip(take);
          const selected = take.promptId === using;
          const label = `Take ${index + 1}${take.prompt.trim() ? ` — ${take.prompt.trim()}` : ""}`;
          return (
            <button
              key={take.promptId}
              type="button"
              aria-pressed={selected}
              aria-label={`Take ${index + 1}`}
              title={label}
              // A take still in the queue has nothing to show yet, and using
              // it is what Redo already did.
              disabled={take.phase !== "done"}
              onClick={() => onPick(take.promptId)}
              className={`relative grid size-12 shrink-0 place-items-center overflow-hidden rounded border
                bg-black transition-colors disabled:cursor-default ${
                  selected
                    ? "border-accent ring-2 ring-accent/30"
                    : "border-border-default hover:border-border-strong"
                }`}
            >
              {clip ? (
                <video
                  // A fraction in, so the frame is the shot rather than a
                  // black first frame.
                  src={`${withToken(clip.url)}#t=0.1`}
                  muted
                  playsInline
                  preload="metadata"
                  className="pointer-events-none size-full object-cover"
                />
              ) : take.phase === "queued" || take.phase === "running" ? (
                <Spinner className="size-3.5 text-fg-subtle" />
              ) : (
                <span className="text-[12px] text-danger" aria-hidden="true">
                  ✕
                </span>
              )}
              <span className="absolute inset-x-0 bottom-0 bg-black/55 text-center font-mono text-[9px] leading-3 text-white">
                {index + 1}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** A scene's rendered clip. */
function sceneClip(job: Job | undefined) {
  return job?.outputs.find((file) => /\.(mp4|webm|mov)$/i.test(file.filename));
}

/** The joined file a stitch saved, not the scene previews it also reports. */
function joinedUrl(job: Job | undefined): string | undefined {
  return job?.outputs.find(
    (file) => file.type === "output" && /^music_video.*\.(mp4|webm|mov)$/i.test(file.filename),
  )?.url;
}

function FinishedVideo({
  url,
  label,
  download,
  compact = false,
}: {
  url: string;
  label?: string;
  download: string;
  compact?: boolean;
}) {
  return (
    <div className="mb-5">
      {label ? <p className="mb-1.5 text-[12px] font-medium text-fg-muted">{label}</p> : null}
      <video
        src={withToken(url)}
        controls
        playsInline
        preload="metadata"
        // Held to the viewport: a portrait video at the panel's full width is
        // taller than the screen, which puts its controls out of sight.
        className={`mx-auto block rounded-lg border border-border-default bg-black object-contain ${compact ? "max-h-[40vh] w-full sm:w-64" : "max-h-[75vh] w-full"}`}
      />
      <div className="mt-2 flex gap-2">
        <a
          href={withToken(url)}
          download={download}
          className={buttonClasses({ variant: "secondary", size: "sm" })}
        >
          Download
        </a>
      </div>
    </div>
  );
}

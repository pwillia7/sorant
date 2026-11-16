"use client";

import {
  Ban,
  Check,
  Circle,
  Clock3,
  Images,
  Link2,
  LoaderCircle,
  MessageSquareQuote,
  Mic,
  MicVocal,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type { MusicVideoController } from "@/hooks/use-music-video";
import { withToken } from "@/lib/client";
import { formatDuration, totalRenderMs, type Job } from "@/lib/jobs";
import {
  carriesOn,
  chainStale,
  keepsVideoLook,
  MUSIC_VIDEO_FRAME_RATES,
  MUSIC_VIDEO_UPSCALE_SIZES,
  openerOf,
  SCENE_VOICES,
  sceneHasReferences,
  videoReferences,
  videoVoices,
  type DirectorAsk,
  type SceneReference,
  type SceneVoice,
} from "@/lib/music-video/project";
import { clock, MUSIC_VIDEO_PICTURES, STORY_SCENE_SECONDS } from "@/lib/music-video/scenes";
import { REFERENCE_KEEP_OPTIONS } from "@/lib/workflows/minimax-common";
import { Badge, Panel, PanelHeader } from "./ui/panel";
import { Button, buttonClasses, Spinner } from "./ui/button";
import { ClipPlayer, type ClipItem } from "./ui/clip-player";
import { JobRunTime, RunTime } from "./ui/run-time";
import { AudioUpload } from "./ui/audio-upload";
import { ImageUpload } from "./ui/image-upload";
import { NumberInput, Segmented, Select, TextArea, TextInput, Toggle } from "./ui/inputs";

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

/** Where a multi-scene video's steps read differently: it has no song. */
const STORY_STEP_HINT: Partial<Record<MusicVideoController["step"], string>> = {
  idle: "Write the idea, choose how many scenes, then plan the video.",
  planning: "Planning the scenes…",
  planned: "Read the scenes through, change any you like — add a scene or take one out — then render them.",
  stitching: "Joining the scenes, each with its own sound…",
};

/** The lengths a multi-scene video's scene can be set to, in whole seconds. */
const STORY_LENGTHS = Array.from(
  { length: STORY_SCENE_SECONDS.max - STORY_SCENE_SECONDS.min + 1 },
  (_, index) => STORY_SCENE_SECONDS.min + index,
);

export function MusicVideoPanel({ video }: { video: MusicVideoController }) {
  const { project, step } = video;
  const story = project?.kind === "story" || video.kind === "story";
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
  /** Every scene with a clip, for the large viewer to step through. */
  const sceneClips: ClipItem[] = scenes.flatMap((scene, index) => {
    const clip = sceneClip(jobs[index]);
    return clip
      ? [{ url: withToken(clip.url), title: `Scene ${index + 1}`, subtitle: `${clock(scene.start)}–${clock(scene.end)}`, download: `scene-${index + 1}.mp4` }]
      : [];
  });
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
        title={story ? "Multi-scene video" : "Music video"}
        hint={(story ? STORY_STEP_HINT[step] : undefined) ?? STEP_HINT[step]}
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
            : story
              ? project?.values.choose_scene_count === true
                ? "The director is picking how many scenes."
                : `${scenes.length === 1 ? "One scene" : `${scenes.length} scenes`}.`
              : `${scenes.length} scenes, ${clock(project?.songSeconds ?? 0)} of song.`}
        </p>
      ) : null}

      {upscaledUrl ? (
        <FinishedVideo
          url={upscaledUrl}
          label="Upscaled"
          download={`${story ? "multi_scene" : "music_video"}_${project?.id ?? ""}_upscaled.mp4`}
          took={totalRenderMs([
            ...scenes.map(video.jobFor),
            ...scenes.map(video.upscaleFor),
            video.upscaledFinal,
          ])}
        />
      ) : null}
      {finalUrl ? (
        <FinishedVideo
          url={finalUrl}
          label={upscaledUrl ? "Original" : undefined}
          download={`${story ? "multi_scene" : "music_video"}_${project?.id ?? ""}.mp4`}
          compact={Boolean(upscaledUrl)}
          took={totalRenderMs([...scenes.map(video.jobFor), video.final])}
        />
      ) : null}

      {scenes.some((scene) => scene.shot) ? (
        <>
          {/*
            How the people in the pictures look, once for every scene. Only
            when the planner wrote one: without pictures there is nobody to
            hold, and a project planned before this existed has none. A
            story's planner also describes the people in no picture, and the
            footage, so a story always has one.
          */}
          {project?.look !== undefined &&
          (project.values.reference_image_1 || project.kind === "story") ? (
            <div className="mb-3 rounded-lg border border-border-default p-3">
              <label
                htmlFor="music-video-look"
                className="mb-1 block text-[12px] font-medium text-fg"
              >
                {project.kind === "story" ? "How the people and the footage look in every scene" : "How they look in every scene"}
              </label>
              <TextArea
                id="music-video-look"
                value={project.look}
                rows={project.kind === "story" ? 6 : 3}
                maxLength={4000}
                onChange={(value) => video.editLook(value)}
              />
              <p className="mt-1 text-[12px] leading-snug text-fg-subtle">
                {project.kind === "story"
                  ? "Given word for word to every scene, so each person keeps one face and outfit, and the footage one look, across the cuts. Edits apply to scenes rendered from now on."
                  : "Given word for word to every scene, so the costume and any style picture\u2019s look hold across the cuts. Edits apply to scenes rendered from now on."}
              </p>
            </div>
          ) : null}
          {project ? (
            <div className="mb-3 rounded-lg border border-border-default p-3">
              <AskDirector
                id="music-video-ask"
                label="Ask the director"
                placeholder="Make it more like a Monty Python sketch. The presenter is a woman."
                button="Revise every scene"
                help="Revises the outline, the look and every shot from what they say now, so your edits are kept. The scenes stay as many and as long as they are; rendered scenes keep their takes until you render them again."
                busy={Boolean(project.revisePromptId) || (video.asking && project.asks?.at(-1)?.scene === undefined)}
                disabled={step === "planning" || step === "stitching" || video.asking}
                asks={(project.asks ?? []).filter((ask) => ask.scene === undefined)}
                onAsk={video.askVideo}
                undo={project.beforeAsk && !video.asking ? video.undoAsk : undefined}
              />
            </div>
          ) : null}
          <ol className="flex flex-col gap-3">
            {scenes.map((scene, index) => {
              const job = jobs[index];
              const clip = sceneClip(job);
              const busy = job?.phase === "queued" || job?.phase === "running";
              return (
                <li key={scene.id ?? `${scene.start}-${index}`}>
                  <SceneCard
                    index={index}
                    job={job}
                    clip={clip}
                    busy={busy}
                    story={story}
                    video={video}
                    onMeasure={measure}
                    siblings={sceneClips}
                  />
                </li>
              );
            })}
          </ol>

          {/* Pinned to the foot of the stage while the scenes scroll under
              it, so what to do next is never forty scenes away. */}
          <div
            className="sticky bottom-0 z-10 -mx-4 -mb-4 mt-4 flex flex-wrap items-center gap-3 sm:-mx-5 sm:-mb-5
              rounded-b-xl border-t border-border-default bg-surface/95 px-4 py-3 backdrop-blur-md sm:px-5"
          >
            <div
              role="progressbar"
              aria-label="Scenes rendered"
              aria-valuemin={0}
              aria-valuemax={scenes.length}
              aria-valuenow={finished}
              className="h-1 w-full overflow-hidden rounded-full bg-track"
            >
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-300"
                style={{ width: `${scenes.length ? (finished / scenes.length) * 100 : 0}%` }}
              />
            </div>
            {video.lostCount > 0 ? (
              <Button
                variant="primary"
                disabled={video.recovering}
                onClick={() => void video.recover()}
                title="This device lost contact with the ComfyUI machine while these scenes or upscales were queued, so they may have finished anyway. Looks for their clips on the machine before anything is sent again."
              >
                {video.recovering
                  ? "Looking…"
                  : `Find ${video.lostCount === 1 ? "the lost clip" : `the ${video.lostCount} lost clips`} on the machine`}
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
                  {upscaleRemaining === 0 ? (
                    <Button
                      onClick={() => void video.joinUpscaled()}
                      title="Every scene is upscaled. Joins them into the upscaled video again, after the last try failed."
                    >
                      Join the upscaled scenes
                    </Button>
                  ) : (
                    <Button
                      onClick={() => void video.upscaleAll(upscaleSize, upscaleRate)}
                      title={`Upscales every scene to ${upscaleSize} px${upscaleRate > 1 ? ` at ${24 * upscaleRate} fps` : ""}, then joins the upscaled scenes into a second video. Roughly ${upscaleTime(upscaleSize)} for this song.`}
                    >
                      {upscaleRemaining < scenes.length
                        ? `Upscale the ${upscaleRemaining} remaining`
                        : "Upscale the video"}
                    </Button>
                  )}
                  {project?.upscaleSize ? (
                    <span className="text-[12px] text-fg-subtle">
                      at {project.upscaleSize} px
                      {upscaleRate > 1 ? `, ${24 * upscaleRate} fps` : ""}, like the rest
                    </span>
                  ) : (
                    <>
                    <Segmented
                      label="Upscale size"
                      value={upscaleSize}
                      onChange={setChosenSize}
                      options={MUSIC_VIDEO_UPSCALE_SIZES.map(({ px }) => ({
                        value: px,
                        disabled: !enlarges(px),
                        title: enlarges(px)
                          ? undefined
                          : `The scenes are already ${smallestSide} px on their shorter side`,
                        label: (
                          <>
                            {px === 2160 ? "4K" : `${px} px`}
                            <span className="ml-1.5 font-normal text-fg-subtle">~{upscaleTime(px)}</span>
                          </>
                        ),
                      }))}
                    />
                    <Segmented
                      label="Upscale frame rate"
                      value={upscaleRate}
                      onChange={setChosenRate}
                      options={MUSIC_VIDEO_FRAME_RATES.map(({ multiplier, label }) => ({
                        value: multiplier,
                        label,
                        title:
                          multiplier > 1
                            ? "Makes a new frame between every pair with RIFE, for smoother motion. The song is unchanged."
                            : "Keeps H3's own frames.",
                      }))}
                    />
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

/**
 * Where a scene's take has got, by shape as well as colour: an empty circle
 * not rendered, a clock queued, a spinner rendering, a tick done, a cross
 * failed. Colour alone left "not rendered" and "queued" the same grey chip.
 */
function SceneStatus({ job }: { job: Job | undefined }) {
  const icon = { className: "size-3 shrink-0 stroke-2", "aria-hidden": true } as const;
  if (!job) {
    return (
      <Badge>
        <Circle {...icon} /> not rendered
      </Badge>
    );
  }
  switch (job.phase) {
    case "queued":
      return (
        <Badge>
          <Clock3 {...icon} /> queued{job.queuePosition ? ` · ${job.queuePosition} ahead` : ""}
        </Badge>
      );
    case "running":
      return (
        <Badge tone="accent">
          <LoaderCircle {...icon} className="size-3 shrink-0 stroke-2 motion-safe:animate-spin" /> rendering
        </Badge>
      );
    case "done":
      return (
        <Badge tone="success">
          <Check {...icon} /> done
        </Badge>
      );
    case "cancelled":
      return (
        <Badge tone="warning">
          <Ban {...icon} /> cancelled
        </Badge>
      );
    default:
      return (
        <Badge tone="danger">
          <X {...icon} /> failed
        </Badge>
      );
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
    (file) => file.type === "output" && /^(music_video|multi_scene).*\.(mp4|webm|mov)$/i.test(file.filename),
  )?.url;
}

function FinishedVideo({
  url,
  label,
  download,
  compact = false,
  took,
}: {
  url: string;
  label?: string;
  download: string;
  compact?: boolean;
  /** Render time of every scene take in it and the join, when all are known. */
  took?: number | null;
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
        {took != null ? (
          <span className="ml-auto self-center">
            <RunTime
              ms={took}
              suffix="in all"
              title={`${formatDuration(took)}: the render time of every run that made this video, added up. Waiting in the queue is not counted.`}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A scene's line of the planner's outline, under its shot: where it is, what
 * happens, whether anyone sings — and a button that writes the shot again
 * from it. Editing the line leaves the shot alone until then, so a hand-edited
 * shot is never replaced by surprise.
 */
function SceneOutline({
  index,
  scene,
  disabled,
  video,
}: {
  index: number;
  scene: NonNullable<MusicVideoController["project"]>["scenes"][number];
  disabled: boolean;
  video: MusicVideoController;
}) {
  const rewriting = Boolean(scene.rewritePromptId);
  const story = video.project?.kind === "story";
  return (
    <div className="flex flex-col gap-2">
      <label className="text-[12px] text-fg-muted" htmlFor={`scene-${index}-place`}>
        Where
      </label>
      <TextInput
        id={`scene-${index}-place`}
        value={scene.place ?? ""}
        disabled={disabled || rewriting}
        onChange={(place) => video.editOutline(index, { place })}
      />
      <label className="text-[12px] text-fg-muted" htmlFor={`scene-${index}-happens`}>
        What happens
      </label>
      <TextInput
        id={`scene-${index}-happens`}
        value={scene.happens ?? ""}
        placeholder={story ? "She opens the door. Cut to: him, on the sofa, looking up." : undefined}
        disabled={disabled || rewriting}
        onChange={(happens) => video.editOutline(index, { happens })}
      />
      {story ? (
        <>
          <label className="text-[12px] text-fg-muted" htmlFor={`scene-${index}-lines`}>
            Lines
          </label>
          <TextArea
            id={`scene-${index}-lines`}
            value={scene.lines ?? ""}
            rows={2}
            maxLength={1000}
            placeholder="Nobody speaks. Or, a line per turn — Mara: We're too late."
            disabled={disabled || rewriting}
            onChange={(lines) => video.editOutline(index, { lines })}
          />
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {story ? null : (
          <>
            <Toggle
              id={`scene-${index}-sings`}
              checked={scene.sings === true}
              disabled={disabled || rewriting}
              describedBy={`scene-${index}-sings-help`}
              onChange={(sings) => video.editOutline(index, { sings })}
            />
            <label className="text-[12px] text-fg" htmlFor={`scene-${index}-sings`}>
              Sings
            </label>
          </>
        )}
        <Button
          variant="quiet"
          size="xs"
          className="ml-auto"
          disabled={disabled || rewriting || !(scene.place?.trim() || scene.happens?.trim())}
          onClick={() => void video.rewriteShot(index)}
        >
          {rewriting ? (
            <>
              <Spinner /> Rewriting…
            </>
          ) : (
            "Rewrite shot"
          )}
        </Button>
      </div>
      <p id={`scene-${index}-sings-help`} className="text-[12px] leading-snug text-fg-subtle">
        {story
          ? "The shot quotes the lines word for word. Changes here take effect when the shot is rewritten."
          : "Off for an instrumental stretch: a mouth moving to words where there is no voice looks wrong. Changes here take effect when the shot is rewritten."}
      </p>
    </div>
  );
}

/**
 * A line to the director: what to change, sent with what is there now, so
 * the reply is a revision rather than a fresh start. What has been asked
 * before is listed above it, oldest first, so a run of asks reads as a
 * conversation.
 */
function AskDirector({
  id,
  label,
  placeholder,
  button,
  help,
  busy,
  disabled,
  asks,
  onAsk,
  undo,
}: {
  id: string;
  label: string;
  placeholder: string;
  button: string;
  help?: string;
  busy: boolean;
  disabled: boolean;
  asks: DirectorAsk[];
  onAsk: (ask: string) => Promise<void>;
  undo?: () => void;
}) {
  const [ask, setAsk] = useState("");
  const send = async () => {
    const text = ask.trim();
    if (!text || disabled) return;
    await onAsk(text);
    setAsk("");
  };
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <label className="text-[12px] font-medium text-fg-muted" htmlFor={id}>
        {label}
      </label>
      {asks.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {asks.slice(-4).map((item) => (
            <li key={item.at} className="text-[12px] leading-snug text-fg-subtle">
              <span className="text-fg-muted">You asked:</span> {item.ask}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <div className="min-w-0 flex-1">
          <TextInput
            id={id}
            value={ask}
            placeholder={placeholder}
            disabled={disabled}
            describedBy={help ? `${id}-help` : undefined}
            onChange={setAsk}
          />
        </div>
        <Button type="submit" variant="secondary" size="sm" disabled={disabled || !ask.trim()}>
          {busy ? (
            <>
              <Spinner /> Revising…
            </>
          ) : (
            button
          )}
        </Button>
        {undo ? (
          <Button type="button" variant="quiet" size="sm" onClick={undo}>
            Undo last ask
          </Button>
        ) : null}
      </div>
      {help ? (
        <p id={`${id}-help`} className="text-[12px] leading-snug text-fg-subtle">
          {help}
        </p>
      ) : null}
    </form>
  );
}

/**
 * The pictures a scene renders from: the video's, until it is given its own.
 * Giving it its own starts from a copy of the video's, so adding someone who
 * appears only here is one more picture rather than all of them again.
 */
function ScenePictures({
  index,
  disabled,
  video,
}: {
  index: number;
  disabled: boolean;
  video: MusicVideoController;
}) {
  const project = video.project;
  const scene = project?.scenes[index];
  if (!project || !scene) return null;
  const own = scene.references;
  const shared = videoReferences(project);
  const look = keepsVideoLook(project, scene);
  // Kept contiguous, as the form keeps its slots: a cleared picture closes up.
  const set = (update: (current: SceneReference[]) => SceneReference[]) =>
    video.editReferences(index, (current) =>
      update(current ?? []).filter((reference) => reference.image),
    );
  const slots = own ? Math.min(own.length + 1, MUSIC_VIDEO_PICTURES) : 0;
  return (
    <div className="flex flex-col gap-2">
      <div className="mt-2 flex flex-col gap-3">
        {own ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              {Array.from({ length: slots }, (_, slot) => {
                const reference = own[slot];
                const id = `scene-${index}-picture-${slot + 1}`;
                return (
                  // Keyed by its picture, so a message about one that went
                  // missing leaves with it rather than sitting on the next.
                  <div key={`${slot}-${reference?.image ?? ""}`} className="flex min-w-0 flex-col gap-1.5">
                    <label className="text-[12px] text-fg-muted" htmlFor={id}>
                      &lt;Picture {slot + 1}&gt;
                    </label>
                    <ImageUpload
                      id={id}
                      label={`Scene ${index + 1}, picture ${slot + 1}`}
                      compact={slot > 0}
                      value={reference?.image ?? ""}
                      disabled={disabled}
                      onChange={(image) =>
                        set((current) => {
                          // By the picture it showed, not the slot: another
                          // slot's change may have moved it up already.
                          const at = reference ? current.findIndex((other) => other.image === reference.image) : -1;
                          const next = [...current];
                          next[at === -1 ? current.length : at] = { image, keep: reference?.keep ?? "everything" };
                          return next;
                        })
                      }
                    />
                    {reference ? (
                      <Select
                        id={`${id}-keep`}
                        value={reference.keep}
                        disabled={disabled}
                        options={REFERENCE_KEEP_OPTIONS}
                        onChange={(keep) =>
                          set((current) =>
                            current.map((other) => (other.image === reference.image ? { ...other, keep } : other)),
                          )
                        }
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <p className="min-w-0 flex-1 text-[12px] leading-snug text-fg-subtle">
                {look
                  ? "Name a picture added here in the shot by its number, as the shot names the rest."
                  : "These no longer start with the video's pictures, so this scene is not given the look above: its director describes the people from these pictures. Name them in the shot by number."}{" "}
                Applies when the scene is next rendered.
              </p>
              <Button
                variant="quiet"
                size="xs"
                disabled={disabled}
                onClick={() => video.editReferences(index, undefined)}
              >
                Use the video&apos;s pictures
              </Button>
            </div>
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-0 flex-1 text-[12px] leading-snug text-fg-subtle">
              {shared.length > 0
                ? `Renders from the video's ${shared.length === 1 ? "picture" : `${shared.length} pictures`}.`
                : project.kind === "story"
                  ? "The video has no pictures."
                  : "The video has no pictures, so this scene renders from the idea alone."}
            </p>
            <Button
              variant="quiet"
              size="xs"
              disabled={disabled}
              onClick={() => video.editReferences(index, shared)}
            >
              Use different pictures
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A multi-scene video's voices for one scene: the video's, until it is given
 * its own — the voice of someone who speaks only here, or none, for a scene
 * none of them are in. Its own start as a copy of the video's, as the
 * pictures do.
 */
function SceneVoices({
  index,
  disabled,
  video,
}: {
  index: number;
  disabled: boolean;
  video: MusicVideoController;
}) {
  const project = video.project;
  const scene = project?.scenes[index];
  if (!project || !scene) return null;
  const own = scene.voices;
  const shared = videoVoices(project);
  const voices = own ?? shared;
  const set = (update: (current: SceneVoice[]) => SceneVoice[]) =>
    video.editVoices(index, (current) => update(current ?? []).filter((voice) => voice.audio));
  const slots = own ? Math.min(own.length + 1, SCENE_VOICES) : 0;
  const guessed = openerOf({ ...scene, opener: undefined }, voices);
  const named = (voice: SceneVoice | undefined, fallback: string) => voice?.owner || fallback;
  return (
    <div className="flex flex-col gap-2">
      <div className="mt-2 flex flex-col gap-3">
        {own ? (
          <>
            {Array.from({ length: slots }, (_, slot) => {
              const voice = own[slot];
              const id = `scene-${index}-voice-${slot + 1}`;
              const change = (patch: Partial<SceneVoice>) =>
                set((current) =>
                  current.map((other) => (other.audio === voice?.audio ? { ...other, ...patch } : other)),
                );
              return (
                <div key={`${slot}-${voice?.audio ?? ""}`} className="flex min-w-0 flex-col gap-1.5">
                  <label className="text-[12px] text-fg-muted" htmlFor={id}>
                    {slot === 0 ? "Voice" : "Second voice"}
                  </label>
                  <AudioUpload
                    id={id}
                    value={voice?.audio ?? ""}
                    noun="voice recording"
                    disabled={disabled}
                    onChange={(audio) =>
                      set((current) => {
                        const at = voice ? current.findIndex((other) => other.audio === voice.audio) : -1;
                        const next = [...current];
                        next[at === -1 ? current.length : at] = {
                          audio,
                          owner: voice?.owner ?? "",
                          start: voice?.start ?? 0,
                          seconds: voice?.seconds ?? 5,
                          length: 0,
                        };
                        return next;
                      })
                    }
                    onMeasure={(length) => {
                      if (voice && voice.length !== length) change({ length });
                    }}
                  />
                  {voice ? (
                    <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
                      <div className="flex flex-col gap-1">
                        <label className="text-[12px] text-fg-muted" htmlFor={`${id}-owner`}>
                          Whose voice
                        </label>
                        <TextInput
                          id={`${id}-owner`}
                          value={voice.owner}
                          disabled={disabled}
                          onChange={(owner) => change({ owner })}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-[12px] text-fg-muted" htmlFor={`${id}-start`}>
                          Start at (s)
                        </label>
                        <NumberInput
                          id={`${id}-start`}
                          value={voice.start}
                          min={0}
                          max={3600}
                          step={0.5}
                          disabled={disabled}
                          onChange={(start) => change({ start })}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </>
        ) : (
          <p className="text-[12px] leading-snug text-fg-subtle">
            {shared.length > 0
              ? `Speaks with the video's ${shared.length === 1 ? "voice" : "two voices"}${shared.some((voice) => voice.owner) ? ` (${shared.map((voice) => voice.owner).filter(Boolean).join(", ")})` : ""}.`
              : "The video has no voices, so anyone who speaks here gets a voice from the words alone."}
          </p>
        )}
        {voices.length === 2 ? (
          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-fg-muted" htmlFor={`scene-${index}-opener`}>
              Speaks first
            </label>
            <Select
              id={`scene-${index}-opener`}
              value={scene.opener ?? "auto"}
              disabled={disabled}
              options={[
                {
                  value: "auto",
                  label: `From the lines — ${guessed === "second" ? named(voices[1], "the second voice") : named(voices[0], "the first voice")}`,
                },
                { value: "first", label: named(voices[0], "The first voice") },
                { value: "second", label: named(voices[1], "The second voice") },
              ]}
              onChange={(opener) =>
                video.editOpener(index, opener === "first" || opener === "second" ? opener : undefined)
              }
            />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-[12px] leading-snug text-fg-subtle">
            {own
              ? "Name each voice's speaker as the lines do. Applies when the scene is next rendered."
              : "Give this scene its own to add someone who speaks only here, or to leave out a voice whose speaker is not in it."}
          </p>
          <Button
            variant="quiet"
            size="xs"
            disabled={disabled}
            onClick={() => video.editVoices(index, own ? undefined : shared)}
          >
            {own ? "Use the video's voices" : "Use different voices"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * One scene as a storyboard frame: its take on the left (or its number and
 * time, before there is one), and on the right what it is and what it says,
 * a tab at a time.
 *
 * It used to be a text box with three disclosures stacked under it, which
 * made forty scenes a long column of text with the pictures off to the side;
 * a storyboard is what tells you whether the cast and the look hold from one
 * cut to the next.
 */
type SceneTab = "shot" | "outline" | "pictures" | "voices" | "takes";

function SceneCard({
  index,
  job,
  clip,
  busy,
  story,
  video,
  onMeasure,
  siblings,
}: {
  index: number;
  job: Job | undefined;
  clip: ReturnType<typeof sceneClip>;
  busy: boolean;
  story: boolean;
  video: MusicVideoController;
  onMeasure: (url: string, element: HTMLVideoElement) => void;
  /** Every scene with a clip, for the large viewer to step through. */
  siblings: ClipItem[];
}) {
  const project = video.project;
  const scene = project?.scenes[index];
  // A scene put in by hand starts on its outline, which is what it needs first.
  const [tab, setTab] = useState<SceneTab>(story && scene && !scene.shot ? "outline" : "shot");
  if (!project || !scene) return null;
  const takes = video.takesFor(index);
  const tabs: Array<{ id: SceneTab; label: string; icon?: ReactNode }> = [
    { id: "shot", label: "Shot" },
    ...(story || scene.place || scene.happens ? [{ id: "outline" as const, label: "Outline" }] : []),
    {
      id: "pictures",
      label: scene.references ? `Pictures · own (${scene.references.length})` : "Pictures",
      icon: <Images className="size-3.5" aria-hidden="true" />,
    },
    ...(story
      ? [
          {
            id: "voices" as const,
            label: scene.voices ? `Voices · own (${scene.voices.length})` : "Voices",
            icon: <Mic className="size-3.5" aria-hidden="true" />,
          },
        ]
      : []),
    ...(takes.length > 1 ? [{ id: "takes" as const, label: `Takes · ${takes.length}` }] : []),
  ];
  const shown = tabs.some((entry) => entry.id === tab) ? tab : "shot";
  const finished = job && (job.phase === "done" || ["error", "cancelled", "unknown"].includes(job.phase));

  return (
    <div className="grid gap-3 rounded-lg border border-border-default p-3 sm:grid-cols-[240px_minmax(0,1fr)]">
      <div className="flex flex-col gap-1.5">
        {clip ? (
          <ClipPlayer
            item={siblings.find((entry) => entry.url === withToken(clip.url)) ?? { url: withToken(clip.url), title: `Scene ${index + 1}` }}
            siblings={siblings}
            loop
            onLoadedMetadata={(event) => onMeasure(clip.url, event.currentTarget)}
            className="aspect-video w-full rounded-md border border-border-default"
          />
        ) : (
          <div
            className="grid aspect-video w-full place-items-center rounded-md border border-dashed
              border-border-strong bg-bg-subtle text-center"
          >
            <span className="flex flex-col items-center gap-0.5">
              <span className="text-[13px] font-medium text-fg">Scene {index + 1}</span>
              <span className="font-mono text-[11px] text-fg-subtle">
                {clock(scene.start)}–{clock(scene.end)}
              </span>
            </span>
          </div>
        )}
        <span className="flex items-center justify-between font-mono text-[11px] text-fg-subtle">
          <span>{clip ? `Scene ${index + 1}` : null}</span>
          <span>{clip ? `${clock(scene.start)}–${clock(scene.end)}` : null}</span>
        </span>
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-fg-muted">
          <SceneStatus job={job} />
          <JobRunTime job={job} />
          {story ? (
            <label
              className="flex items-center gap-1"
              title="How long this scene runs. The scenes after it move along; a scene already rendered keeps its length until it is redone."
            >
              <span className="sr-only">Scene {index + 1} length</span>
              <select
                value={Math.round(scene.seconds ?? scene.end - scene.start)}
                disabled={busy}
                onChange={(event) => video.editLength(index, Number(event.target.value))}
                className="rounded-md border border-border-default bg-bg px-1.5 py-0.5 text-[12px] text-fg disabled:opacity-50"
              >
                {STORY_LENGTHS.map((seconds) => (
                  <option key={seconds} value={seconds}>
                    {seconds} s
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <Badge>{(scene.end - scene.start).toFixed(1)} s</Badge>
          )}
          {scene.part ? (
            <Badge>
              <span title="Where the planner thinks this scene falls in the song. It cannot hear the song, so it is a guess from the lyrics and the loudness.">
                {scene.part}
              </span>
            </Badge>
          ) : null}
          {scene.sings ? (
            <Badge tone="accent">
              <MicVocal className="size-3" aria-hidden="true" /> sings
            </Badge>
          ) : null}
          {story && scene.lines?.trim() ? (
            <Badge tone="accent">
              <MessageSquareQuote className="size-3" aria-hidden="true" /> lines
            </Badge>
          ) : null}
          {story && index > 0 ? (
            <button
              type="button"
              aria-pressed={carriesOn(project, index)}
              disabled={busy}
              onClick={() => video.editContinues(index, !carriesOn(project, index))}
              title={
                carriesOn(project, index)
                  ? `Carries on from the end of scene ${index}: rendered from its last second, with no cut, so this scene's own pictures and voices are not used. It waits for scene ${index} to finish, and a new take of scene ${index} means rendering this one again. Click to draw it on its own instead. Press Rewrite shot after switching, so the shot opens and ends the right way.`
                  : `Drawn on its own, after a cut. Click to carry it on from the end of scene ${index} instead — same people, light and motion, no cut. Press Rewrite shot after switching, so the shot opens where scene ${index} ends.`
              }
              className={`inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 text-[11px] leading-4 font-medium
                whitespace-nowrap transition-colors disabled:opacity-50
                ${
                  carriesOn(project, index)
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-dashed border-border-default text-fg-muted hover:text-fg"
                }`}
            >
              <Link2 className="size-3" aria-hidden="true" />
              {carriesOn(project, index) ? `carries on from ${index}` : "cut"}
            </button>
          ) : null}
          {scene.waiting ? (
            <Badge>
              <Clock3 className="size-3" aria-hidden="true" /> waiting for scene {index}
            </Badge>
          ) : chainStale(project, index) ? (
            <Badge tone="warning">
              <span title={`Made from a take of scene ${index} the video no longer uses, so the join would jump. Render the video again to carry it on from the take in use.`}>
                scene {index} changed
              </span>
            </Badge>
          ) : null}
          {carriesOn(project, index) || sceneHasReferences(project, scene) ? null : (
            <Badge>
              <span title="With no pictures and no voices, this scene is made from its words alone.">
                Text to Video
              </span>
            </Badge>
          )}
          <span className="ml-auto flex items-center gap-1">
            {finished ? (
              <Button
                variant="quiet"
                size="xs"
                icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
                onClick={() => void video.redo(index)}
                title={`Render another take on a fresh seed, with the shot as it reads now. The takes you have stay to pick from.${carriesOn(project, index + 1) ? ` Scene ${index + 2} carries on from this one, so it will need rendering again too.` : ""}`}
              >
                Redo
              </Button>
            ) : null}
            {story ? (
              <>
                <Button
                  variant="quiet"
                  size="xs"
                  icon={<Plus className="size-3.5" aria-hidden="true" />}
                  disabled={!video.canReshapeAt(index + 1)}
                  onClick={() => video.addScene(index)}
                  title={
                    video.canReshapeAt(index + 1)
                      ? "Put a blank scene in after this one: fill in its outline, then Rewrite shot. The scenes after it move along."
                      : "A scene after this one has been rendered, so nothing can go in before it. Add scenes after the last rendered one."
                  }
                >
                  Scene after
                </Button>
                {project.scenes.length > 1 ? (
                  <Button
                    variant="quiet"
                    size="xs"
                    icon={<Trash2 className="size-3.5" aria-hidden="true" />}
                    disabled={!video.canReshapeAt(index)}
                    onClick={() => video.removeScene(index)}
                    aria-label={`Remove scene ${index + 1}`}
                    title={
                      video.canReshapeAt(index)
                        ? "Take this scene out. The scenes after it move up."
                        : "This scene, or one after it, has been rendered, so it stays."
                    }
                  />
                ) : null}
              </>
            ) : null}
          </span>
        </div>

        <div role="tablist" aria-label={`Scene ${index + 1}`} className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-border-default [scrollbar-width:none]">
          {tabs.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`scene-${index}-tab-${entry.id}`}
              aria-selected={shown === entry.id}
              aria-controls={`scene-${index}-panel`}
              onClick={() => setTab(entry.id)}
              className={`-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-2 py-1.5 text-[12px] transition-colors
                ${
                  shown === entry.id
                    ? "border-fg font-medium text-fg"
                    : "border-transparent text-fg-muted hover:text-fg"
                }`}
            >
              {entry.icon}
              {entry.label}
            </button>
          ))}
        </div>

        <div id={`scene-${index}-panel`} role="tabpanel" aria-labelledby={`scene-${index}-tab-${shown}`}>
          {shown === "shot" ? (
            <TextArea
              id={`scene-${index}`}
              value={scene.shot}
              rows={3}
              maxLength={2000}
              // Editable except while its take is in the queue: the run has
              // already been handed what it said. And while the shot is being
              // rewritten, which would replace it.
              disabled={busy || Boolean(scene.rewritePromptId)}
              onChange={(value) => video.editShot(index, value)}
            />
          ) : null}
          {shown === "shot" ? (
            <div className="mt-2">
              <AskDirector
                id={`scene-${index}-ask`}
                label="Ask the director about this shot"
                placeholder="Make him angrier. End on the glass breaking."
                button="Revise shot"
                busy={Boolean(scene.rewritePromptId)}
                disabled={busy || video.asking || !scene.shot?.trim()}
                asks={(project?.asks ?? []).filter((ask) => ask.scene === index)}
                onAsk={(ask) => video.askScene(index, ask)}
              />
            </div>
          ) : shown === "outline" ? (
            <SceneOutline index={index} scene={scene} disabled={busy} video={video} />
          ) : shown === "pictures" ? (
            <ScenePictures index={index} disabled={busy} video={video} />
          ) : shown === "voices" ? (
            <SceneVoices index={index} disabled={busy} video={video} />
          ) : (
            <TakePicker
              takes={takes}
              using={scene.promptId}
              onPick={(promptId) => video.pickTake(index, promptId)}
            />
          )}
        </div>

        {job?.phase === "error" && job.error ? (
          <p className="text-[12px] leading-relaxed text-danger">{job.error}</p>
        ) : null}
      </div>
    </div>
  );
}

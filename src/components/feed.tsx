"use client";

import {
  AudioLines,
  CornerDownRight,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { StarIcon } from "@/components/ui/star-icon";
import { withToken } from "@/lib/client";
import {
  clockMs,
  dayKey,
  formatDuration,
  formatWhen,
  groupByDay,
  historyEntries,
  isActive,
  isAudioOnly,
  isFavorite,
  isImageOnly,
  partitionFavorites,
  type Job,
  type MusicVideoGroup,
} from "@/lib/jobs";
import { workflowIcon } from "./workflow-icons";

const VIDEO = /\.(mp4|webm|mov|mkv|m4v)$/i;
const DOWNLOAD_STAGGER_MS = 300;
const FAVORITES_KEY = "favorites";

/**
 * The gallery: every generation on this device, as pictures, newest day first
 * and favourites above them all. This is the page — the composer floats over
 * its foot and the settings slide in from the side, so what has been made is
 * what the screen is mostly made of.
 *
 * A tile shows its state on the picture itself: a run in flight is a clock and
 * a filling line where the frame will be, a failure says so in place. Opening
 * one puts it in the viewer, which is where every action on a result lives;
 * the tile keeps only what is worth doing without opening it.
 */
export function Feed({
  jobs,
  now,
  estimateFor,
  onOpen,
  onCancel,
  onRemove,
  onRemoveMany,
  onToggleFavorite,
  onClearFinished,
  onRetry,
  canRetry,
  onRerun,
  canRerun,
  retrying,
  inUse,
  empty,
}: {
  jobs: Job[];
  now: number;
  estimateFor: (job: Job) => number | null;
  onOpen: (promptId: string) => void;
  onCancel: (promptId: string) => void;
  onRemove: (promptId: string) => void;
  onRemoveMany: (promptIds: string[]) => void;
  onToggleFavorite: (promptId: string) => void;
  onClearFinished: () => void;
  onRetry?: (job: Job) => void;
  canRetry?: (job: Job) => boolean;
  onRerun?: (job: Job) => void;
  canRerun?: (job: Job) => boolean;
  retrying?: boolean;
  /** The takes a planned video is using; its tile shows those. */
  inUse?: ReadonlySet<string>;
  /** What the page shows before anything has been made. */
  empty: ReactNode;
}) {
  const [pending, setPending] = useState<{ day: string; action: "download" | "delete" } | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // One player for every track in the gallery, so only one plays at a time
  // and collapsing a day does not cut it off.
  const player = useRef<HTMLAudioElement | null>(null);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const toggleTrack = useCallback(
    (job: Job) => {
      const element = player.current;
      const file = job.outputs[0];
      if (!element || !file) return;
      if (playingId === job.promptId) {
        element.pause();
        setPlayingId(null);
        return;
      }
      element.src = withToken(file.url);
      setPlayingId(job.promptId);
      void element.play().catch(() => setPlayingId(null));
    },
    [playingId],
  );
  useEffect(() => {
    if (playingId === null || jobs.some((job) => job.promptId === playingId)) return;
    player.current?.pause();
    setPlayingId(null);
  }, [jobs, playingId]);

  const today = dayKey(now);
  const groups = useMemo(() => {
    const { favorites, rest } = partitionFavorites(jobs);
    const days = groupByDay(rest, now).map((group) => ({ ...group, pinned: false }));
    return favorites.length > 0
      ? [{ key: FAVORITES_KEY, label: "Favorites", jobs: favorites, pinned: true }, ...days]
      : days;
    // `today` stands in for `now`: regrouping only matters when the day turns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, today]);

  if (jobs.length === 0) return <>{empty}</>;

  const finishedCount = jobs.filter((job) => !isActive(job) && !isFavorite(job)).length;

  return (
    <div className="flex flex-col gap-10">
      {groups.map((group) => {
        const open = !collapsed[group.key];
        const downloadable = group.jobs.filter((job) => job.outputs.length > 0);
        const confirming = pending?.day === group.key ? pending.action : null;
        return (
          <section key={group.key} aria-labelledby={`day-${group.key}`}>
            <header className="mb-4 flex min-h-8 flex-wrap items-baseline gap-x-3 gap-y-2">
              <button
                type="button"
                id={`day-${group.key}`}
                onClick={() => setCollapsed((previous) => ({ ...previous, [group.key]: open }))}
                aria-expanded={open}
                className="flex items-baseline gap-2 text-left"
              >
                {group.pinned ? <StarIcon filled className="size-4 self-center text-accent" /> : null}
                <span className="display-tight text-[24px] font-semibold leading-none text-fg">{group.label}</span>
                <span className="font-mono text-[12px] tabular-nums text-fg-subtle">{group.jobs.length}</span>
                {open ? null : <span className="text-[12px] text-fg-subtle">— show</span>}
              </button>
              <div className="ml-auto flex items-center gap-1.5">
                {confirming ? (
                  <>
                    <span className="text-[12px] text-fg-muted">
                      {confirming === "download"
                        ? `Download ${downloadable.length} ${downloadable.length === 1 ? "file" : "files"}?`
                        : `Forget ${group.jobs.length}? Files stay on your ComfyUI.`}
                    </span>
                    <Button
                      size="xs"
                      variant={confirming === "delete" ? "quiet-danger" : "quiet"}
                      onClick={() => {
                        if (confirming === "download") downloadAll(downloadable);
                        else onRemoveMany(group.jobs.map((job) => job.promptId));
                        setPending(null);
                      }}
                    >
                      {confirming === "download" ? "Download" : "Delete"}
                    </Button>
                    <Button size="xs" variant="quiet" onClick={() => setPending(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    {downloadable.length > 0 ? (
                      <Button size="xs" variant="quiet" onClick={() => setPending({ day: group.key, action: "download" })}>
                        Download all
                      </Button>
                    ) : null}
                    {/* No bulk delete on favourites: marking them was asking to keep them. */}
                    {group.pinned ? null : (
                      <Button size="xs" variant="quiet-danger" onClick={() => setPending({ day: group.key, action: "delete" })}>
                        Delete
                      </Button>
                    )}
                  </>
                )}
              </div>
            </header>

            {open ? (
              <ul className="grid grid-cols-1 gap-x-5 gap-y-7 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {historyEntries(group.jobs).map((entry) =>
                  entry.kind === "music-video" ? (
                    <li key={`mv-${entry.group.projectId}`}>
                      <ProjectTile group={entry.group} now={now} inUse={inUse} onOpen={onOpen} />
                    </li>
                  ) : (
                    <li key={entry.job.promptId}>
                      <Tile
                        job={entry.job}
                        derived={entry.depth > 0}
                        now={now}
                        estimate={isActive(entry.job) ? estimateFor(entry.job) : null}
                        playing={playingId === entry.job.promptId}
                        onOpen={onOpen}
                        onCancel={onCancel}
                        onRemove={onRemove}
                        onToggleFavorite={onToggleFavorite}
                        onToggleTrack={toggleTrack}
                        onRetry={onRetry && canRetry?.(entry.job) ? onRetry : undefined}
                        onRerun={onRerun && canRerun?.(entry.job) ? onRerun : undefined}
                        retrying={retrying}
                      />
                    </li>
                  ),
                )}
              </ul>
            ) : null}
          </section>
        );
      })}

      {finishedCount > 0 ? (
        <Button
          variant="quiet-danger"
          size="xs"
          className="self-start"
          onClick={onClearFinished}
          title="Forget every finished generation. Favorites are kept."
        >
          Clear {finishedCount} finished
        </Button>
      ) : null}

      <audio ref={player} onEnded={() => setPlayingId(null)} onError={() => setPlayingId(null)} aria-hidden="true" />
    </div>
  );
}

/** hh:mm:ss for the clock on a running tile. */
function timecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  const hours = Math.floor(total / 3600);
  return `${hours > 0 ? `${pad(hours)}:` : ""}${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * The picture for a finished run: the still, or the clip, which plays muted
 * while pointed at. Only asked for once the tile is near the screen — a long
 * gallery is dozens of requests otherwise.
 */
function TileMedia({ job }: { job: Job }) {
  const ref = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);

  const file = job.outputs.find((output) => (output.type || "output") === "output") ?? job.outputs[0];
  const Icon = workflowIcon(job.workflowId);
  const audio = isAudioOnly(job);
  const still = file && isImageOnly(job);
  const clip = file && !audio && !still && VIDEO.test(file.filename);

  return (
    <div
      ref={ref}
      className="absolute inset-0 grid place-items-center text-screen-muted"
      onPointerEnter={() => void video.current?.play().catch(() => undefined)}
      onPointerLeave={() => {
        if (!video.current) return;
        video.current.pause();
        video.current.currentTime = 0.1;
      }}
    >
      {near && still ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={withToken(file.url)} alt="" className="size-full object-cover" />
      ) : near && clip ? (
        <video
          ref={video}
          src={`${withToken(file.url)}#t=0.1`}
          muted
          loop
          playsInline
          preload="metadata"
          className="size-full object-cover"
        />
      ) : audio ? (
        <AudioLines className="size-10 stroke-[1.25]" aria-hidden="true" />
      ) : (
        <Icon className="size-8 stroke-[1.25]" aria-hidden="true" />
      )}
    </div>
  );
}

function Tile({
  job,
  derived,
  now,
  estimate,
  playing,
  onOpen,
  onCancel,
  onRemove,
  onToggleFavorite,
  onToggleTrack,
  onRetry,
  onRerun,
  retrying,
}: {
  job: Job;
  derived: boolean;
  now: number;
  estimate: number | null;
  playing: boolean;
  onOpen: (promptId: string) => void;
  onCancel: (promptId: string) => void;
  onRemove: (promptId: string) => void;
  onToggleFavorite: (promptId: string) => void;
  onToggleTrack: (job: Job) => void;
  onRetry?: (job: Job) => void;
  onRerun?: (job: Job) => void;
  retrying?: boolean;
}) {
  const active = isActive(job);
  const favorite = isFavorite(job);
  const done = job.phase === "done" && job.outputs.length > 0;
  const elapsed = clockMs(job, now);
  const Icon = workflowIcon(job.workflowId);
  const rendering = job.startedAt ? (now - job.startedAt) / 1000 : 0;
  const fraction =
    job.phase === "running" && job.startedAt && estimate
      ? Math.min(0.95, 1 - Math.exp(-rendering / (estimate * 0.55)))
      : null;
  const label = job.prompt.trim() || job.workflowName;

  return (
    <article className="group flex flex-col gap-2.5">
      <button
        type="button"
        onClick={() => onOpen(job.promptId)}
        aria-label={`Open: ${label}`}
        className={`relative block aspect-video w-full overflow-hidden rounded-xl bg-screen text-left
          ring-offset-2 ring-offset-bg transition-shadow hover:ring-2 hover:ring-border-strong
          ${job.phase === "running" ? "ring-2 ring-accent hover:ring-accent" : ""}`}
      >
        {done ? <TileMedia job={job} /> : null}

        {active ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 screen-idle text-screen-fg">
            <span className="font-mono text-[28px] font-medium tabular-nums leading-none">
              {elapsed === null ? "--:--" : timecode(elapsed)}
            </span>
            <span className="label-caps text-screen-muted">
              {job.phase === "running"
                ? "Generating"
                : job.queuePosition
                  ? `Queued · ${job.queuePosition} ahead`
                  : "Queued"}
            </span>
            <span className="absolute inset-x-0 bottom-0 h-1 overflow-hidden bg-white/10">
              {fraction === null ? (
                job.phase === "running" ? <span className="sweep absolute inset-0" /> : null
              ) : (
                <span
                  className="block h-full bg-accent transition-[width] duration-500"
                  style={{ width: `${fraction * 100}%` }}
                />
              )}
            </span>
          </div>
        ) : !done ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center screen-idle">
            <span
              className={`label-caps ${job.phase === "error" ? "text-[#ff6b62]" : "text-[#e9c55a]"}`}
            >
              {job.phase === "error"
                ? "Failed"
                : job.phase === "cancelled"
                  ? "Cancelled"
                  : job.phase === "done"
                    ? "Nothing came back"
                    : "Lost track"}
            </span>
            {job.error ? (
              <span className="line-clamp-2 text-[12px] leading-snug text-screen-muted">{job.error}</span>
            ) : null}
          </div>
        ) : null}

        {/* What made it, top-left, on every tile. */}
        <span className="absolute left-2.5 top-2.5 flex items-center gap-1.5 rounded-md bg-black/60 px-1.5 py-1 text-white backdrop-blur-sm">
          <Icon className="size-3.5" aria-hidden="true" />
          <span className="hidden text-[11px] font-medium group-hover:inline">{job.workflowName}</span>
        </span>
        {favorite ? (
          <span className="absolute right-2.5 top-2.5 rounded-md bg-black/60 p-1 text-accent backdrop-blur-sm">
            <StarIcon filled className="size-3.5" />
          </span>
        ) : null}
      </button>

      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[13px] leading-snug text-fg">
            {derived ? (
              <CornerDownRight
                className="mr-1 inline size-3.5 -translate-y-px text-fg-subtle"
                aria-label="Made from an earlier generation"
              />
            ) : null}
            {label}
          </p>
          <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px] tabular-nums text-fg-subtle">
            <span>{formatWhen(job.submittedAt, now)}</span>
            {done && job.completedAt ? <span>· {formatDuration(job.completedAt - job.submittedAt)}</span> : null}
          </p>
        </div>

        {/* Always visible: a touch screen has no hover to find them with. */}
        <div className="flex shrink-0 items-center gap-0.5">
          {done && isAudioOnly(job) ? (
            <IconButton label={playing ? "Pause" : "Play this track"} onClick={() => onToggleTrack(job)} pressed={playing}>
              {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
            </IconButton>
          ) : null}
          {onRetry ? (
            <IconButton label="Run this again with the same settings" onClick={() => onRetry(job)} disabled={retrying}>
              <RotateCw className="size-4" aria-hidden="true" />
            </IconButton>
          ) : null}
          {onRerun ? (
            <IconButton label="Run again with these settings and a new seed" onClick={() => onRerun(job)} disabled={retrying}>
              <RotateCcw className="size-4" aria-hidden="true" />
            </IconButton>
          ) : null}
          {active ? (
            <IconButton label="Cancel this generation" onClick={() => onCancel(job.promptId)} tone="danger">
              <X className="size-4" aria-hidden="true" />
            </IconButton>
          ) : (
            <>
              <IconButton
                label={favorite ? "Remove from favorites" : "Add to favorites"}
                onClick={() => onToggleFavorite(job.promptId)}
                pressed={favorite}
              >
                <StarIcon filled={favorite} className={`size-4 ${favorite ? "text-accent" : ""}`} />
              </IconButton>
              <IconButton label="Remove from library" onClick={() => onRemove(job.promptId)} tone="danger">
                <Trash2 className="size-4" aria-hidden="true" />
              </IconButton>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function IconButton({
  label,
  onClick,
  children,
  pressed,
  disabled,
  tone,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  disabled?: boolean;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      className={`grid size-8 place-items-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover
        disabled:opacity-40 ${tone === "danger" ? "hover:text-danger" : "hover:text-fg"}`}
    >
      {children}
    </button>
  );
}

/** A planned video — a music video, a multi-scene film, a long swap — as one tile. */
function ProjectTile({
  group,
  now,
  inUse,
  onOpen,
}: {
  group: MusicVideoGroup;
  now: number;
  inUse?: ReadonlySet<string>;
  onOpen: (promptId: string) => void;
}) {
  const pick = (slot: Job[]) => slot.find((job) => inUse?.has(job.promptId)) ?? slot[0];
  const scenes = group.parts.scene.map(pick);
  const joined = [...group.parts["upscaled-join"], ...group.parts.join].map(pick).find((job) => job.phase === "done");
  const target = joined ?? scenes[0] ?? group.jobs[0];
  const total = group.sceneCount ?? scenes.length;
  const doneCount = scenes.filter((job) => job.phase === "done").length;
  const active = group.jobs.filter(isActive).length;
  const failed = scenes.filter((job) => ["error", "cancelled", "unknown"].includes(job.phase)).length;
  const frames = scenes.length > 0 ? scenes.slice(0, 3) : [target];

  return (
    <article className="flex flex-col gap-2.5">
      <button
        type="button"
        onClick={() => onOpen(target.promptId)}
        aria-label={`Open: ${group.label} — ${group.title}`}
        className={`relative grid aspect-video w-full overflow-hidden rounded-xl bg-screen ring-offset-2 ring-offset-bg
          transition-shadow hover:ring-2 hover:ring-border-strong ${active > 0 ? "ring-2 ring-accent" : ""}`}
        style={{ gridTemplateColumns: `repeat(${frames.length}, minmax(0, 1fr))` }}
      >
        {frames.map((job) => (
          <span key={job.promptId} className="relative border-r border-black last:border-r-0">
            {job.phase === "done" ? <TileMedia job={job} /> : <span className="absolute inset-0 screen-idle" />}
          </span>
        ))}
        <span className="label-caps absolute left-2.5 top-2.5 rounded-md bg-black/60 px-1.5 py-1 text-white backdrop-blur-sm">
          {group.label}
        </span>
      </button>
      <div>
        <p className="line-clamp-2 text-[13px] leading-snug text-fg">{group.title}</p>
        <p className="mt-1 font-mono text-[11px] tabular-nums text-fg-subtle">
          {[
            formatWhen(group.newest, now),
            total > 0 ? `${doneCount}/${total} ${group.noun}s` : "planning",
            active > 0 ? `${active} running` : null,
            failed > 0 ? `${failed} failed` : null,
            joined ? "joined" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
    </article>
  );
}

/** Saves each primary output, staggered: browsers drop a burst of downloads. */
function downloadAll(jobs: Job[]): void {
  jobs
    .map((job) => job.outputs[0])
    .filter((file) => file !== undefined)
    .forEach((file, index) => {
      setTimeout(() => {
        const anchor = document.createElement("a");
        anchor.href = withToken(file.url);
        anchor.download = file.filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }, index * DOWNLOAD_STAGGER_MS);
    });
}

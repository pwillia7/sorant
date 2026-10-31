"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Dot } from "@/components/ui/panel";
import { withToken } from "@/lib/client";
import {
  clockMs,
  dayKey,
  formatDuration,
  formatWhen,
  groupByDay,
  isActive,
  isAudioOnly,
  isImageOnly,
  isFavorite,
  historyEntries,
  partitionFavorites,
  type Job,
  type MusicVideoGroup,
} from "@/lib/jobs";
import { RerunIcon } from "@/components/ui/rerun-icon";
import { StarIcon } from "@/components/ui/star-icon";

const PHASE_LABEL: Record<Job["phase"], string> = {
  queued: "Queued",
  running: "Generating",
  done: "Done",
  error: "Failed",
  cancelled: "Cancelled",
  unknown: "Lost",
};

const PHASE_TONE: Record<
  Job["phase"],
  "neutral" | "accent" | "success" | "warning" | "danger"
> = {
  queued: "neutral",
  running: "accent",
  done: "success",
  error: "danger",
  cancelled: "warning",
  unknown: "warning",
};

/** Browsers throttle a burst of programmatic downloads; this paces them. */
const DOWNLOAD_STAGGER_MS = 300;

/** What a day's header is asking the user to confirm, if anything. */
type Pending = { day: string; action: "download" | "delete" } | null;

/**
 * The favourites section's own key, in the same namespace as the day keys it
 * sits above. It cannot collide with one: those are `YYYY-MM-DD`.
 */
const FAVORITES_KEY = "favorites";

/**
 * Past and in-flight generations for this device, grouped by the day they were
 * started.
 *
 * Only references are kept, so an entry stops playing if ComfyUI's output
 * directory is cleared. That is worth the trade — storing the video itself
 * would exhaust localStorage after a couple of clips.
 */
export function GenerationsPanel({
  jobs,
  selectedId,
  now,
  onSelect,
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
}: {
  jobs: Job[];
  selectedId: string | null;
  now: number;
  onSelect: (promptId: string) => void;
  onCancel: (promptId: string) => void;
  onRemove: (promptId: string) => void;
  onRemoveMany: (promptIds: string[]) => void;
  onToggleFavorite: (promptId: string) => void;
  onClearFinished: () => void;
  /** Run a failed generation again, as it was. Absent offers no retry at all. */
  onRetry?: (job: Job) => void;
  /**
   * Whether this particular run can be offered one — the phase is only half of
   * it, since the workflow that made it may no longer be registered. Asked of
   * the owner rather than worked out here, which has no list of workflows.
   */
  canRetry?: (job: Job) => boolean;
  /** Another take of a finished generation: its settings, a new seed. */
  onRerun?: (job: Job) => void;
  /** As `canRetry`, for `onRerun`. */
  canRerun?: (job: Job) => boolean;
  /** A submission is in flight, so every retry button waits its turn. */
  retrying?: boolean;
  /**
   * The scene takes and upscales the current music video is using. Its entry
   * shows those, one per scene; the other takes are the panel's to pick from.
   */
  inUse?: ReadonlySet<string>;
}) {
  /**
   * Per-day open state, but only where the user has said otherwise: the newest
   * day is open by default and the rest are closed, so a long history collapses
   * to a readable index without hiding what was just made. Keying on the day
   * rather than the position means a new day inherits the default rather than
   * whatever the day above it was set to.
   */
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>(
    {},
  );
  const [pending, setPending] = useState<Pending>(null);

  /**
   * One player for the whole list, rather than one per row.
   *
   * Two things fall out of that and both are wanted. Only one track can play at
   * a time, because there is only one element to play it — starting a second
   * row replaces the source of the first. And it sits outside the day sections,
   * so collapsing the day a playing track is in does not unmount the thing
   * playing it.
   */
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
      // Rejects when a second row replaces this source mid-load, and when the
      // file is no longer in ComfyUI's output directory — the same way a
      // deleted generation stops playing in the stage. Either way the button
      // goes back to offering a play, which is the honest report of what
      // happened.
      void element.play().catch(() => setPlayingId(null));
    },
    [playingId],
  );

  // A track whose row has just been forgotten has no pause button left to
  // press, so it is stopped here rather than left playing out of nowhere.
  useEffect(() => {
    if (playingId === null) return;
    if (jobs.some((job) => job.promptId === playingId)) return;
    player.current?.pause();
    setPlayingId(null);
  }, [jobs, playingId]);

  // Keyed on the calendar day rather than on `now`, which ticks every second
  // while anything is running. All `now` decides here is whether a heading says
  // "Today", so regrouping the whole history a second at a time was buying one
  // label change at midnight.
  const today = dayKey(now);
  const groups = useMemo(() => {
    // Favourites are lifted out of their days rather than copied above them,
    // so nothing appears twice and a day's Download and Delete still act on
    // exactly the rows that day is showing.
    const { favorites, rest } = partitionFavorites(jobs);
    const days = groupByDay(rest, now).map((group) => ({
      ...group,
      pinned: false,
    }));
    return favorites.length > 0
      ? [
          {
            key: FAVORITES_KEY,
            label: "Favorites",
            jobs: favorites,
            pinned: true,
          },
          ...days,
        ]
      : days;
    // `now` is read through `today`, which is what the dependency list names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs, today]);

  if (jobs.length === 0) {
    return (
      <p className="py-2 text-[13px] leading-relaxed text-fg-subtle">
        Nothing yet. Generations you run on this device show up here.
      </p>
    );
  }

  // Favourites are excluded because `onClearFinished` spares them; counting
  // them here would promise to remove rows that would still be there after.
  const finishedCount = jobs.filter(
    (job) => !isActive(job) && !isFavorite(job),
  ).length;
  const firstDayIndex = groups.findIndex((group) => !group.pinned);

  const renderRow = (job: Job, caption?: string) => (
    <Row
      job={job}
      caption={caption}
      now={now}
      selected={job.promptId === selectedId}
      playing={job.promptId === playingId}
      onSelect={onSelect}
      onCancel={onCancel}
      onRemove={onRemove}
      onRetry={onRetry && canRetry?.(job) ? onRetry : undefined}
      onRerun={onRerun && canRerun?.(job) ? onRerun : undefined}
      retrying={retrying}
      onToggleFavorite={onToggleFavorite}
      onToggleTrack={toggleTrack}
    />
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-3">
        {groups.map((group, index) => {
          // Favourites and the newest day both open by default: the section is
          // there to be read, and burying it under a closed header would make
          // marking something feel like filing it away.
          const open =
            openOverrides[group.key] ?? (group.pinned || index === firstDayIndex);
          const downloadable = group.jobs.filter(
            (job) => job.outputs.length > 0,
          );
          const confirming = pending?.day === group.key ? pending.action : null;

          return (
            <section key={group.key}>
              {/* The confirmation takes the whole row rather than squeezing in
                  beside the toggle: the question needs the width, and there is
                  nothing else worth doing while it is being asked. */}
              <header className="mb-1.5 flex h-6 items-center gap-2">
                {confirming ? null : (
                  <button
                    type="button"
                    onClick={() =>
                      setOpenOverrides((previous) => ({
                        ...previous,
                        [group.key]: !open,
                      }))
                    }
                    aria-expanded={open}
                    className="group flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  >
                    <svg
                      viewBox="0 0 16 16"
                      className={`size-3 shrink-0 text-fg-subtle transition-transform duration-200
                        ${open ? "rotate-90" : ""}`}
                      aria-hidden="true"
                    >
                      <path
                        d="M6 4l4 4-4 4"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        fill="none"
                      />
                    </svg>
                    {group.pinned ? (
                      <StarIcon
                        filled
                        className="size-3 shrink-0 text-accent"
                      />
                    ) : null}
                    <span
                      className="truncate text-[11px] font-medium uppercase tracking-[0.08em]
                        text-fg-subtle transition-colors group-hover:text-fg-muted"
                    >
                      {group.label}
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
                      {group.jobs.length}
                    </span>
                  </button>
                )}

                {confirming ? (
                  <ConfirmBar
                    action={confirming}
                    count={
                      confirming === "download"
                        ? downloadable.length
                        : group.jobs.length
                    }
                    onCancel={() => setPending(null)}
                    onConfirm={() => {
                      if (confirming === "download") downloadAll(downloadable);
                      else onRemoveMany(group.jobs.map((job) => job.promptId));
                      setPending(null);
                    }}
                  />
                ) : (
                  <div className="flex shrink-0 items-center gap-1.5">
                    {downloadable.length > 0 ? (
                      <Button
                        variant="quiet"
                        size="xs"
                        onClick={() =>
                          setPending({ day: group.key, action: "download" })
                        }
                      >
                        Download
                      </Button>
                    ) : null}
                    {/* No bulk delete on the favourites: one click that
                        forgets the entries someone marked to keep is the
                        opposite of what marking them was for. The row's own
                        remove button is still there for one at a time. */}
                    {group.pinned ? null : (
                      <Button
                        variant="quiet-danger"
                        size="xs"
                        onClick={() =>
                          setPending({ day: group.key, action: "delete" })
                        }
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                )}
              </header>

              {open ? (
                <ul className="flex flex-col gap-1.5">
                  {historyEntries(group.jobs).map((entry) =>
                    entry.kind === "music-video" ? (
                      <li key={`mv-${entry.group.projectId}`}>
                        <MusicVideoEntry
                          group={entry.group}
                          now={now}
                          selectedId={selectedId}
                          // Closed until asked, even holding the selected run:
                          // that is whatever was queued last, which during a
                          // video is always one of its parts.
                          open={
                            openOverrides[`mv-${entry.group.projectId}`] ?? false
                          }
                          onToggle={(next) =>
                            setOpenOverrides((current) => ({
                              ...current,
                              [`mv-${entry.group.projectId}`]: next,
                            }))
                          }
                          renderRow={(job, caption) => renderRow(job, caption)}
                          inUse={inUse}
                        />
                      </li>
                    ) : (
                      <li
                        key={entry.job.promptId}
                        // Indented under whatever it was made from, with a
                        // rule down the left so a source and its takes read as
                        // one thing rather than as neighbours.
                        className={
                          entry.depth > 0
                            ? "ml-3 border-l border-border-default pl-3"
                            : undefined
                        }
                        style={
                          entry.depth > 1
                            ? { marginLeft: `${entry.depth * 0.75}rem` }
                            : undefined
                        }
                      >
                        {renderRow(entry.job)}
                      </li>
                    ),
                  )}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>

      {finishedCount > 0 ? (
        <Button
          variant="quiet-danger"
          size="xs"
          className="mt-1 self-start"
          onClick={onClearFinished}
          title="Forget every finished generation. Favorites are kept."
        >
          Clear {finishedCount} finished
        </Button>
      ) : null}

      {/* No `controls`, so it draws nothing: the row's own button is the
          transport. The stage is where a track gets a scrubber — this is here
          so playing one does not mean scrolling back up to it. */}
      <audio
        ref={player}
        onEnded={() => setPlayingId(null)}
        onError={() => setPlayingId(null)}
        aria-hidden="true"
      />
    </div>
  );
}

/**
 * Confirmation in place of the actions it replaces, rather than a dialog.
 * Both of these are one click from a mis-hit and one of them is destructive,
 * but neither is weighty enough to be worth taking over the screen — and the
 * question reads better sitting on the row it applies to.
 */
function ConfirmBar({
  action,
  count,
  onConfirm,
  onCancel,
}: {
  action: "download" | "delete";
  count: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // "generations" rather than "videos": a selection can now hold music too,
  // and the bar counts whatever is ticked without looking at what it is.
  const noun = `${count} ${count === 1 ? "generation" : "generations"}`;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-[11px] text-fg-muted">
        {action === "download"
          ? `Download ${noun}?`
          : /* Naming what survives: the files themselves are on the ComfyUI
               box and this only forgets where they are. */
            `Forget ${noun}? Files stay on the server.`}
      </span>
      <Button
        variant={action === "delete" ? "quiet-danger" : "quiet"}
        size="xs"
        onClick={onConfirm}
      >
        {action === "download" ? "Download" : "Delete"}
      </Button>
      <Button variant="quiet" size="xs" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function Row({
  job,
  caption,
  now,
  selected,
  playing,
  onSelect,
  onCancel,
  onRemove,
  onToggleFavorite,
  onToggleTrack,
  onRetry,
  onRerun,
  retrying,
}: {
  job: Job;
  /** What the row is within a music video — "Scene 3", "Upscaled video". */
  caption?: string;
  now: number;
  selected: boolean;
  /** Whether the panel's player is on this row's track right now. */
  playing: boolean;
  onSelect: (promptId: string) => void;
  onCancel: (promptId: string) => void;
  onRemove: (promptId: string) => void;
  onToggleFavorite: (promptId: string) => void;
  onToggleTrack: (job: Job) => void;
  /** Present only on a row worth offering one. See `isRetryable`. */
  onRetry?: (job: Job) => void;
  /** Present only on a finished row. See `isRerunnable`. */
  onRerun?: (job: Job) => void;
  retrying?: boolean;
}) {
  const active = isActive(job);
  const favorite = isFavorite(job);
  /**
   * A track can be played from the row it is on, without selecting it.
   *
   * Selecting is what the rest of the row does, and it puts the generation in
   * the stage — which on a long history is a scroll away, so hearing a track
   * you made an hour ago meant going up to the top and then finding your place
   * again. Only audio gets this: a video needs the picture, which is the
   * stage's job.
   */
  const playable = !active && isAudioOnly(job);
  // The same clock the stage runs, so a generation is not one number in the
  // list and another in the panel. Blank on a finished job that was never seen
  // running — the timestamp beside it already says when, and the alternative is
  // to print a queue wait under a heading that means render. See `clockMs`.
  const elapsed = clockMs(job, now);

  return (
    <div
      className={`group flex items-center gap-2 rounded-lg border p-2 transition-colors
        ${
          selected
            ? "border-accent bg-accent-subtle/30"
            : "border-border-default bg-bg-subtle hover:border-border-strong"
        }`}
    >
      <button
        type="button"
        onClick={() => onSelect(job.promptId)}
        aria-current={selected || undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <Dot tone={PHASE_TONE[job.phase]} pulse={active} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[12px] font-medium text-fg">
              {PHASE_LABEL[job.phase]}
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-subtle">
              {elapsed !== null ? formatDuration(elapsed) : ""}
            </span>
            <span className="ml-auto shrink-0 text-[11px] text-fg-subtle">
              {formatWhen(job.submittedAt, now)}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-1 text-[11px] text-fg-subtle">
            {/* Which kind of file this row leads to, for a list that now holds
                three. Deliberately small and in the muted colour the line it sits
                on already uses: it is a distinction worth being able to see at
                a glance and not worth a badge. Nothing marks a video — the
                absence is the other half of the signal, and marking both would
                put a glyph on every row and distinguish nothing. */}
            {isAudioOnly(job) ? (
              <svg
                viewBox="0 0 16 16"
                className="size-2.5 shrink-0"
                fill="none"
                role="img"
                aria-label="Audio"
              >
                <path
                  d="M6 11.5V3.5l6-1.2v8"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <circle cx="4.5" cy="11.5" r="1.7" stroke="currentColor" strokeWidth="1.4" />
                <circle cx="10.5" cy="10.3" r="1.7" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            ) : isImageOnly(job) ? (
              <svg
                viewBox="0 0 16 16"
                className="size-2.5 shrink-0"
                fill="none"
                role="img"
                aria-label="Image"
              >
                <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
                <path d="M2.5 11l3.5-3.5 3 3 1.5-1.5 3 3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
              </svg>
            ) : null}
            {caption ? (
              <span className="shrink-0 font-medium text-fg-muted">{caption}</span>
            ) : null}
            {/* A captioned row with no prompt of its own — an upscale — says
                enough with the caption; its workflow name would repeat the
                section it sits in. */}
            {caption && !job.prompt.trim() ? null : (
              <span className="min-w-0 truncate">
                {caption ? "· " : ""}
                {job.prompt.trim() || job.workflowName}
              </span>
            )}
          </span>
        </span>
      </button>

      {/* Always visible, unlike the remove button beside it, which appears on
          hover: this is something to reach for rather than a tidy-up, and a
          touch device has no hover to reveal it with. */}
      {playable ? (
        <button
          type="button"
          onClick={() => onToggleTrack(job)}
          title={playing ? "Pause" : "Play this track"}
          aria-label={playing ? "Pause" : "Play this track"}
          aria-pressed={playing}
          className={`grid size-7 shrink-0 place-items-center rounded-md
            transition-colors hover:bg-surface hover:text-fg
            ${playing ? "text-accent" : "text-fg-muted"}`}
        >
          {playing ? (
            <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
              <path
                d="M6 3.5v9M10 3.5v9"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                fill="none"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
              <path
                d="M5.5 3.6v8.8l7-4.4-7-4.4Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
                fill="currentColor"
              />
            </svg>
          )}
        </button>
      ) : null}

      {/* Always visible, like the play button above: a failed run is the one
          row in this list with something that needs doing, and hiding the fix
          behind a hover puts it out of reach of a touch device entirely.

          Only on a failure, and only while nothing else is being submitted —
          the queue takes one at a time, and a button that looked live while
          the last press was still in flight would invite the same run twice. */}
      {onRetry ? (
        <button
          type="button"
          onClick={() => onRetry(job)}
          disabled={retrying}
          title="Run this again with the same settings"
          aria-label="Run this again with the same settings"
          className="grid size-7 shrink-0 place-items-center rounded-md
            text-fg-muted transition-colors hover:bg-surface hover:text-accent
            disabled:cursor-not-allowed disabled:opacity-40
            disabled:hover:bg-transparent disabled:hover:text-fg-muted"
        >
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
            <path
              d="M13 8a5 5 0 1 1-1.7-3.75M13 2.5V5.5h-3"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}

      {/* Beside a finished run, where the retry sits beside a failed one —
          the two never share a row. Its own icon, since this one rolls a new
          seed and loads the form, which the retry does neither of. */}
      {onRerun ? (
        <button
          type="button"
          onClick={() => onRerun(job)}
          disabled={retrying}
          title="Run again with these settings and a new seed"
          aria-label="Run again with these settings and a new seed"
          className="grid size-7 shrink-0 place-items-center rounded-md
            text-fg-muted transition-colors hover:bg-surface hover:text-accent
            disabled:cursor-not-allowed disabled:opacity-40
            disabled:hover:bg-transparent disabled:hover:text-fg-muted"
        >
          <RerunIcon className="size-3.5" />
        </button>
      ) : null}

      {/* Always visible for the same reason as the play button above, and only
          once there is something to keep: a run still in the queue has no
          result yet, and its row already has a cancel to reach for. */}
      {active ? null : (
        <button
          type="button"
          onClick={() => onToggleFavorite(job.promptId)}
          title={favorite ? "Remove from favorites" : "Add to favorites"}
          aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
          aria-pressed={favorite}
          className={`grid size-7 shrink-0 place-items-center rounded-md
            transition-colors hover:bg-surface
            ${favorite ? "text-accent" : "text-fg-subtle hover:text-fg"}`}
        >
          <StarIcon filled={favorite} />
        </button>
      )}

      {active ? (
        <button
          type="button"
          onClick={() => onCancel(job.promptId)}
          title="Cancel this generation"
          aria-label="Cancel this generation"
          className="grid size-7 shrink-0 place-items-center rounded-md
            text-fg-muted transition-colors hover:bg-surface hover:text-danger"
        >
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onRemove(job.promptId)}
          title="Remove from history"
          aria-label="Remove from history"
          className="grid size-7 shrink-0 place-items-center rounded-md
            text-fg-subtle opacity-0 transition-all hover:bg-surface
            hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
        >
          <svg viewBox="0 0 16 16" className="size-3.5" fill="none" aria-hidden="true">
            <path
              d="M3 4.5h10M6.5 4.5V3.5h3v1M5 4.5l.5 8h5l.5-8"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}

/**
 * Saves each generation's primary output, one anchor click at a time.
 *
 * Staggered because browsers treat a burst of programmatic downloads as
 * suspicious and drop all but the first. Chrome also asks once per site
 * whether to allow multiple files, which is part of why this is behind a
 * confirmation — the prompt makes more sense when it was expected.
 *
 * Deliberately not cancelled if the panel unmounts: the user asked for the
 * files, and navigating away should not take back the ones still queued.
 */
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

/** What a section of a music video is called, and what each row in it says. */
const MUSIC_VIDEO_SECTIONS: Array<{
  part: keyof MusicVideoGroup["parts"];
  heading: string;
  caption: (scene: number | undefined) => string;
}> = [
  { part: "upscaled-join", heading: "Video", caption: () => "Upscaled video" },
  { part: "join", heading: "Video", caption: () => "Joined video" },
  { part: "scene", heading: "Scenes", caption: (scene) => `Scene ${(scene ?? 0) + 1}` },
  { part: "upscale", heading: "Upscales", caption: (scene) => `Scene ${(scene ?? 0) + 1}` },
  { part: "plan", heading: "Plan", caption: () => "Scene plan" },
];

/**
 * A whole music video as one entry: a line that says how far it has got, and
 * under it, when opened, its runs by what they are rather than by what they
 * were made from.
 *
 * The scenes and upscales are each one flat list in scene order, one row a
 * scene: the take the video uses, with a count where there are others. The
 * others are picked between in the music video panel, under each scene, so
 * redoing a scene five times does not add five rows here. Closed by default: a
 * video in progress is dozens of queued runs, and the summary line is what is
 * worth reading.
 */
function MusicVideoEntry({
  group,
  now,
  selectedId,
  open,
  onToggle,
  renderRow,
  inUse,
}: {
  group: MusicVideoGroup;
  now: number;
  selectedId: string | null;
  open: boolean;
  onToggle: (open: boolean) => void;
  renderRow: (job: Job, caption?: string) => ReactNode;
  inUse?: ReadonlySet<string>;
}) {
  // The take a slot is showing: the one the video uses where it says, else the
  // newest — which is all an older video, no longer in the panel, has to go on.
  const shown = (slot: Job[]) =>
    slot.find((job) => inUse?.has(job.promptId)) ?? slot[0];
  const current = (part: keyof MusicVideoGroup["parts"]) =>
    group.parts[part].map(shown);
  const scenes = current("scene");
  const upscales = current("upscale");
  const count = (jobs: Job[], phase: Job["phase"]) =>
    jobs.filter((job) => job.phase === phase).length;
  // What still needs a retry: a scene or an upscale whose newest take failed.
  const failed = [...scenes, ...upscales].filter((job) =>
    ["error", "cancelled", "unknown"].includes(job.phase),
  ).length;
  const total = group.sceneCount ?? scenes.length;
  const joined = current("join")[0]?.phase === "done";
  const upscaledJoined = current("upscaled-join")[0]?.phase === "done";
  const active = group.jobs.filter(isActive);
  const running = active.find((job) => job.phase === "running");
  const containsSelected = group.jobs.some((job) => job.promptId === selectedId);

  const summary = [
    total > 0 ? `${count(scenes, "done")} of ${total} scenes` : "planning",
    running ? "1 generating" : null,
    count(active, "queued") > 0 ? `${count(active, "queued")} queued` : null,
    failed > 0 ? `${failed} failed` : null,
    upscales.length > 0 && !upscaledJoined
      ? `${count(upscales, "done")} of ${total} upscaled`
      : null,
    upscaledJoined ? "upscaled" : joined ? "joined" : null,
  ].filter(Boolean);

  const tone = active.length > 0
    ? "accent"
    : failed > 0
      ? "danger"
      : joined
        ? "success"
        : "neutral";

  // Both joins sit under one "Video" heading, the upscaled one first.
  const sections = MUSIC_VIDEO_SECTIONS.map((section) => ({
    ...section,
    slots: group.parts[section.part],
  })).filter((section) => section.slots.length > 0);

  return (
    <div
      className={`rounded-lg border transition-colors ${
        containsSelected && !open
          ? "border-accent"
          : "border-border-default"
      } bg-bg-subtle`}
    >
      <button
        type="button"
        onClick={() => onToggle(!open)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2.5 p-2 text-left"
      >
        <Dot tone={tone} pulse={active.length > 0} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className="shrink-0 text-[12px] font-medium text-fg">
              {group.label}
            </span>
            <span className="min-w-0 truncate text-[11px] text-fg-subtle">
              {group.title}
            </span>
            <span className="ml-auto shrink-0 text-[11px] text-fg-subtle">
              {formatWhen(group.newest, now)}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-fg-muted">
            {summary.join(" · ")}
          </span>
        </span>
        <svg
          viewBox="0 0 16 16"
          className={`size-3 shrink-0 text-fg-subtle transition-transform duration-150 ${
            open ? "rotate-90" : ""
          }`}
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M6 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div className="flex flex-col gap-3 border-t border-border-default p-2">
          {sections.map((section, index) => (
            <section key={section.part} className="flex flex-col gap-1.5">
              {sections[index - 1]?.heading === section.heading ? null : (
                <h4 className="px-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-fg-subtle">
                  {section.heading}
                </h4>
              )}
              <ul className="flex flex-col gap-1.5">
                {section.slots.map((slot) => {
                  const job = shown(slot);
                  const takes = slot.filter((take) => take.phase === "done").length;
                  // One row a slot. The other takes are counted, not listed:
                  // choosing between them is the music video panel's job.
                  const caption = `${section.caption(job.musicVideo?.scene)}${
                    takes > 1 && (section.part === "scene" || section.part === "upscale")
                      ? ` · ${takes} takes`
                      : ""
                  }`;
                  return <li key={slot[0].promptId}>{renderRow(job, caption)}</li>;
                })}
              </ul>
            </section>
          ))}
          {group.untagged.length > 0 ? (
            <section className="flex flex-col gap-1.5">
              <h4 className="px-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-fg-subtle">
                Also made from this video
              </h4>
              <ul className="flex flex-col gap-1.5">
                {group.untagged.map((job) => (
                  <li key={job.promptId}>{renderRow(job)}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

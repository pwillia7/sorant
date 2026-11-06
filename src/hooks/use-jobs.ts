"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StatusPayload } from "@/app/api/status/route";
import { api, ApiError } from "@/lib/client";
import {
  applyRecheck,
  expireStale,
  learnedEstimateSeconds,
  isActive,
  isAudioOnly,
  isFavorite,
  lostTrackOf,
  readJobs,
  sortJobs,
  writeJobs,
  type Job,
  type JobOutput,
  type MusicVideoTag,
} from "@/lib/jobs";
import { notify } from "@/lib/notifications";
import { workflowLabel, type RunModes } from "@/lib/workflows/modes";
import { REWRITE_MODEL } from "@/lib/workflows/rewrite-model";
import type { ParamValue, WorkflowSummary } from "@/lib/workflows/types";

const POLL_INTERVAL_MS = 1500;
/**
 * ComfyUI reports nothing for a moment between accepting a prompt and queueing
 * it. Only treat "unknown" as lost once a job has had well past that to appear.
 */
const SETTLE_GRACE_MS = 60_000;

/**
 * When to stop asking about a job and call the connection, rather than the run,
 * the thing that is broken.
 *
 * Both conditions have to hold, because either one alone gets a case wrong. A
 * count alone trips too early when the failures are instant — a refused
 * connection answers in milliseconds, so three of those are over in a few
 * seconds and a passing blip would kill a render that was going to be fine. A
 * duration alone trips on a single slow answer: an unreachable host is more
 * often blackholed than refused, and one poll then sits for the route's whole
 * 20-second ComfyUI timeout, which is not yet evidence of anything.
 *
 * Together they say: several failures in a row, spanning long enough that this
 * is not a hiccup. In practice that lands around a minute either way — well
 * past any blip, and well short of the day `expireStale` would otherwise take
 * to notice, which is the behaviour this replaces.
 */
const MAX_POLL_FAILURES = 3;
const GIVE_UP_AFTER_MS = 45_000;

/** How many lost runs one recheck asks about, and how many per request. */
const RECHECK_LIMIT = 100;
const RECHECK_BATCH = 25;

/** Backoff for the nth consecutive failure, capped to stay responsive. */
function retryDelayMs(failures: number): number {
  return Math.min(POLL_INTERVAL_MS * 2 ** failures, 10_000);
}

interface GenerateResponse {
  promptId: string;
  queueNumber: number;
  resolved: Record<string, ParamValue>;
  /** The switches the run actually got, which can be fewer than were asked for. */
  patches?: string[];
  /** Which LoRA each content switch applied, and at what. */
  loras?: Job["loras"];
  /** Whether the brief was written on the ComfyUI machine. */
  localDirector?: boolean;
  /** On which local model, by id. */
  localModel?: string;
  /** The file name a batched run writes under. See `Job.runKey`. */
  runKey?: string;
  /** The estimate bucket the server chose, such as "x6" for six slices. See `slicedBy`. */
  variant?: string;
  estimatedSeconds: number | null;
}

export interface JobsController {
  /** Newest first. */
  jobs: Job[];
  activeCount: number;
  /** Median render time for a job's workflow and mode, from this device's own history. */
  estimateFor: (job: Job) => number | null;
  submitting: boolean;
  submitError: string | null;
  submitErrorField: string | null;
  submit: (
    workflow: WorkflowSummary,
    values: Record<string, ParamValue>,
    /** Each mode is only offered where the workflow declares it. */
    options?: RunModes & {
      /** Apply the turbo LoRA the memory-sparing way. Nothing without turbo. */
      lowVram?: boolean;
      /** Write the brief on the ComfyUI machine with this local model id. */
      localDirector?: string;
      /**
       * Write the brief with this gateway model, on a workflow that has one —
       * chosen for the app rather than on the form. See `REWRITE_MODEL`.
       */
      rewriteModel?: string;
      /** The generation whose clip this one was made from, if any. */
      derivedFrom?: string;
      /** The music video this run is part of. See `Job.musicVideo`. */
      musicVideo?: MusicVideoTag;
    },
  ) => Promise<string | null>;
  /**
   * Tag runs as parts of a music video after the fact, by prompt id. Only runs
   * with no tag yet are touched: it is for runs submitted before the tag
   * existed, which the project still knows by id.
   */
  tagMusicVideo: (tags: Record<string, MusicVideoTag>) => void;
  /**
   * Finish runs this device lost track of with the files found for them on the
   * box, by prompt id — or correct a run an earlier search finished. See
   * `lostTrackOf` and `recoverScenes`.
   */
  recover: (found: Record<string, { outputs: JobOutput[]; completedAt: number }>) => void;
  /**
   * Ask ComfyUI again about runs this device lost track of — every one, or
   * these. Resolves to what it said by prompt id, or null when it could not be
   * asked. See `applyRecheck`.
   */
  recheckLost: (promptIds?: string[]) => Promise<Record<string, StatusPayload> | null>;
  cancel: (promptId: string) => Promise<void>;
  remove: (promptId: string) => void;
  /** Drop several at once, so a day's worth is one state write. */
  removeMany: (promptIds: string[]) => void;
  /** Mark or unmark a generation as one to keep. */
  toggleFavorite: (promptId: string) => void;
  /** Everything finished except the favourites, which is the point of them. */
  clearFinished: () => void;
  dismissSubmitError: () => void;
}

/** Fold a poll result into a job, returning the same object when nothing moved. */
function applyStatus(job: Job, status: StatusPayload | undefined): Job {
  if (!status) return job;

  if (status.state === "done") {
    if (job.phase === "done") return job;
    return {
      ...job,
      phase: "done",
      queuePosition: null,
      outputs: status.outputs,
      briefs: status.briefs,
      completedAt: Date.now(),
    };
  }

  if (status.state === "error") {
    if (job.phase === "error") return job;
    return {
      ...job,
      phase: "error",
      queuePosition: null,
      error: status.error ?? "The workflow failed while executing.",
      briefs: status.briefs,
      completedAt: Date.now(),
    };
  }

  if (status.state === "unknown") {
    // Either still settling, or gone for good — ComfyUI restarted and dropped
    // its history, or it was cancelled outside this app.
    if (Date.now() - job.submittedAt < SETTLE_GRACE_MS) return job;
    if (job.phase === "unknown") return job;
    return { ...job, phase: "unknown", queuePosition: null };
  }

  const phase = status.state === "running" ? "running" : "queued";
  // Stamp the moment it leaves the queue, so progress and learned estimates
  // measure rendering rather than waiting.
  const startedAt =
    phase === "running" && job.startedAt === undefined
      ? Date.now()
      : job.startedAt;

  if (
    job.phase === phase &&
    job.queuePosition === status.queuePosition &&
    job.startedAt === startedAt
  ) {
    return job;
  }
  return { ...job, phase, queuePosition: status.queuePosition, startedAt };
}

export function useJobs(): JobsController {
  const [jobs, setJobs] = useState<Job[]>(() =>
    expireStale(sortJobs(readJobs())),
  );
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitErrorField, setSubmitErrorField] = useState<string | null>(null);

  useEffect(() => {
    writeJobs(jobs);
  }, [jobs]);

  // Announce each finished job once. Held in a ref so a re-render cannot
  // produce a duplicate and a reload does not re-announce old history.
  const notifiedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const job of jobs) {
      if (job.phase !== "done" && job.phase !== "error") continue;
      if (notifiedRef.current.has(job.promptId)) continue;
      notifiedRef.current.add(job.promptId);

      // Skip anything already finished when the page loaded.
      if (!job.completedAt || Date.now() - job.completedAt > 10_000) continue;

      if (job.phase === "done") {
        // Named after what actually came back, for the same reason the Generate
        // button is: a desktop notification saying "Video ready" for an mp3 is
        // the app telling someone something untrue while they are elsewhere.
        notify(
          isAudioOnly(job) ? "Music ready" : "Video ready",
          job.workflowName,
          job.promptId,
        );
      } else {
        notify("Generation failed", job.error ?? job.workflowName, job.promptId);
      }
    }
  }, [jobs]);

  const activeIds = useMemo(
    () =>
      jobs
        .filter(isActive)
        .map((job) => job.promptId)
        .sort()
        .join(","),
    [jobs],
  );

  /**
   * Stop waiting on the given jobs, and say so.
   *
   * Reached only from the poll loop, once the status checks have failed for long
   * enough that the connection is the broken thing. The alternative is what this
   * replaces: a job that sits at "Rendering" with a progress bar filling against
   * an estimate, indistinguishable from a slow render, until `expireStale`
   * quietly relabels it a day later. A generation nobody is waiting on any more
   * should say so.
   *
   * It used to send a cancel as well, to save the GPU a clip nothing would
   * collect. Something does collect it now — `recheckLost`, once the connection
   * is back — and the usual cause is this end's internet rather than the box,
   * so the run is left to finish.
   */
  const abandonActive = useCallback((promptIds: string[], cause: unknown) => {
    const detail =
      cause instanceof ApiError ? cause.message : "Lost contact with the server.";
    const doomed = new Set(promptIds);

    setJobs((previous) =>
      previous.map((job) =>
        doomed.has(job.promptId) && isActive(job)
          ? {
              ...job,
              phase: "error" as const,
              queuePosition: null,
              completedAt: Date.now(),
              lostContact: true,
              error:
                `${detail} Gave up after ${MAX_POLL_FAILURES} failed status checks. ` +
                "The run carries on on the ComfyUI machine, and this is checked " +
                "again when the connection is back.",
            }
          : job,
      ),
    );
  }, []);

  // The latest jobs, for `recheckLost`, which is called from effects that
  // should not re-run every time a poll moves a progress bar.
  const jobsRef = useRef(jobs);
  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  const recheckInFlight = useRef<Promise<Record<string, StatusPayload> | null> | null>(null);

  /**
   * Ask ComfyUI again about runs this device lost track of. See `applyRecheck`.
   *
   * Every lost run when no ids are given, newest first and at most
   * `RECHECK_LIMIT` of them — anything older has almost certainly outlived
   * ComfyUI's history, and the route takes `RECHECK_BATCH` ids a request. One
   * check at a time: a second caller while one is in flight shares its answer.
   * Null when ComfyUI could not be asked, so a caller about to send a run again
   * can tell "it has no record" from "nobody answered".
   */
  const recheckLost = useCallback(
    (promptIds?: string[]): Promise<Record<string, StatusPayload> | null> => {
      if (recheckInFlight.current) return recheckInFlight.current;
      const wanted = promptIds ? new Set(promptIds) : null;
      const ids = jobsRef.current
        .filter((job) => lostTrackOf(job) && (!wanted || wanted.has(job.promptId)))
        .sort((a, b) => b.submittedAt - a.submittedAt)
        .slice(0, RECHECK_LIMIT)
        .map((job) => job.promptId);
      if (ids.length === 0) return Promise.resolve({});

      const check = (async () => {
        try {
          const statuses: Record<string, StatusPayload> = {};
          for (let from = 0; from < ids.length; from += RECHECK_BATCH) {
            const batch = ids.slice(from, from + RECHECK_BATCH).join(",");
            const answer = await api<{ statuses: Record<string, StatusPayload> }>(
              `/api/status?promptIds=${encodeURIComponent(batch)}`,
            );
            Object.assign(statuses, answer.statuses);
          }
          setJobs((previous) => {
            const next = previous.map((job) => applyRecheck(job, statuses[job.promptId]));
            return next.some((job, index) => job !== previous[index]) ? next : previous;
          });
          return statuses;
        } catch {
          return null;
        } finally {
          recheckInFlight.current = null;
        }
      })();
      recheckInFlight.current = check;
      return check;
    },
    [],
  );

  // One batched request per tick regardless of how many jobs are in flight,
  // so a deep queue does not multiply load on the ComfyUI box.
  useEffect(() => {
    if (!activeIds) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;

    // The current run of consecutive failures. A closure variable rather than a
    // ref, so it resets whenever the set of active jobs changes: a successful
    // poll is what normally changes that set, and it would have reset anyway.
    let failures = 0;
    let firstFailureAt = 0;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const { statuses } = await api<{
          statuses: Record<string, StatusPayload>;
        }>(`/api/status?promptIds=${encodeURIComponent(activeIds)}`);
        if (cancelled) return;
        failures = 0;
        // The same array back when nothing moved, not a fresh one holding the
        // same objects. `applyStatus` already returns the identical job when a
        // poll says nothing new, so this is a cheap identity check — and it is
        // what stops a tick that changed nothing from re-rendering the history
        // and rewriting the whole of localStorage. Most ticks change nothing:
        // a render sits in `running` for minutes. Without this the cost of
        // keeping history is paid every 1.5 seconds rather than when something
        // actually happens, which is what made its size worth rationing.
        setJobs((previous) => {
          const next = previous.map((job) =>
            applyStatus(job, statuses[job.promptId]),
          );
          return next.some((job, index) => job !== previous[index])
            ? next
            : previous;
        });
        timer = setTimeout(poll, POLL_INTERVAL_MS);
      } catch (cause) {
        if (cancelled) return;
        // An auth failure will not fix itself.
        if (cause instanceof ApiError && cause.status === 401) return;

        failures += 1;
        if (failures === 1) firstFailureAt = Date.now();

        if (
          failures >= MAX_POLL_FAILURES &&
          Date.now() - firstFailureAt >= GIVE_UP_AFTER_MS
        ) {
          // Nothing reschedules from here: giving up settles every job in
          // flight, which empties activeIds and tears this loop down.
          abandonActive(activeIds.split(","), cause);
          return;
        }

        timer = setTimeout(poll, retryDelayMs(failures));
      } finally {
        inFlight = false;
      }
    };

    timer = setTimeout(poll, 300);

    // Hidden tabs get their timers throttled to about once a minute, so catch
    // up the moment the tab is looked at again.
    const onVisibilityChange = () => {
      if (cancelled || document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeIds, abandonActive]);

  const submit = useCallback(
    async (
      workflow: WorkflowSummary,
      values: Record<string, ParamValue>,
      options?: RunModes & {
        lowVram?: boolean;
        localDirector?: string;
        rewriteModel?: string;
        derivedFrom?: string;
        musicVideo?: MusicVideoTag;
      },
    ) => {
      const turbo = Boolean(options?.turbo);
      const asked = options?.patches ?? [];
      // Over whatever the values carry, which may be a stored form's or an
      // old run's: the model is the app's now, and a retry after a refusal is
      // exactly the run that has to go out on the new one.
      const params =
        options?.rewriteModel &&
        !options.localDirector &&
        workflow.params.some((param) => param.id === REWRITE_MODEL)
          ? { ...values, [REWRITE_MODEL]: options.rewriteModel }
          : values;
      setSubmitting(true);
      setSubmitError(null);
      setSubmitErrorField(null);

      try {
        const response = await api<GenerateResponse>("/api/generate", {
          method: "POST",
          body: JSON.stringify({
            workflowId: workflow.id,
            params,
            turbo,
            patches: asked,
            lowVram: Boolean(options?.lowVram),
            lora: options?.lora,
            tier: options?.tier,
            strengths: options?.strengths,
            alternateBase: options?.alternateBase,
            ...(options?.localDirector
              ? { director: "local", localDirector: options.localDirector }
              : {}),
          }),
        });

        // What the run got rather than what was asked for: a step count can
        // refuse a switch, and recording the request would put this generation
        // in the wrong bucket for the estimate and name a mode it did not use.
        const patches = response.patches ?? asked;
        // Same rule: what was written onto the spliced nodes, not what the form
        // was showing. Two takes that differ only by a LoRA strength are exactly
        // the pair the history has to be able to tell apart.
        const loras = response.loras;

        const job: Job = {
          promptId: response.promptId,
          workflowId: workflow.id,
          // The modes are part of what the run was, so they belong in the name
          // that shows in the history and in the notification.
          workflowName: workflowLabel(
            workflow.name,
            { turbo, patches },
            workflow.patches,
          ),
          prompt: String(values.prompt ?? ""),
          turbo,
          patches,
          loras,
          localDirector: response.localDirector === true,
          localModel: response.localModel,
          runKey: response.runKey,
          variant:
            response.variant ??
            (workflow.estimateBy
              ? String(response.resolved?.[workflow.estimateBy.param] ?? "")
              : undefined),
          derivedFrom: options?.derivedFrom,
          musicVideo: options?.musicVideo,
          hasAudio: Boolean(workflow.hasAudio),
          submittedAt: Date.now(),
          phase: "queued",
          queuePosition: null,
          outputs: [],
          resolved: response.resolved,
          estimatedSeconds: response.estimatedSeconds,
        };

        setJobs((previous) => [job, ...previous]);
        return job.promptId;
      } catch (cause) {
        setSubmitError(
          cause instanceof ApiError ? cause.message : "Could not submit the job.",
        );
        setSubmitErrorField(
          cause instanceof ApiError ? (cause.field ?? null) : null,
        );
        return null;
      } finally {
        setSubmitting(false);
      }
    },
    [],
  );

  const cancel = useCallback(async (promptId: string) => {
    // Optimistic: the poll loop settles the real state either way, and the
    // button should not sit there looking unresponsive.
    setJobs((previous) =>
      previous.map((job) =>
        job.promptId === promptId
          ? { ...job, phase: "cancelled", queuePosition: null, completedAt: Date.now() }
          : job,
      ),
    );
    try {
      await api("/api/cancel", {
        method: "POST",
        body: JSON.stringify({ promptId }),
      });
    } catch {
      // Best effort — ComfyUI may have finished it in the meantime.
    }
  }, []);

  const remove = useCallback((promptId: string) => {
    setJobs((previous) => previous.filter((job) => job.promptId !== promptId));
  }, []);

  const removeMany = useCallback((promptIds: string[]) => {
    const doomed = new Set(promptIds);
    setJobs((previous) => previous.filter((job) => !doomed.has(job.promptId)));
  }, []);

  const toggleFavorite = useCallback((promptId: string) => {
    setJobs((previous) =>
      previous.map((job) =>
        job.promptId === promptId ? { ...job, favorite: !job.favorite } : job,
      ),
    );
  }, []);

  // Favourites survive, which is most of what marking one is for: the whole
  // reason to keep a generation is so the tidy-up does not take it.
  const clearFinished = useCallback(() => {
    setJobs((previous) =>
      previous.filter((job) => isActive(job) || isFavorite(job)),
    );
  }, []);

  const dismissSubmitError = useCallback(() => setSubmitError(null), []);

  const estimateFor = useCallback(
    (job: Job) => learnedEstimateSeconds(jobs, job),
    [jobs],
  );

  const tagMusicVideo = useCallback((tags: Record<string, MusicVideoTag>) => {
    setJobs((previous) => {
      if (!previous.some((job) => !job.musicVideo && tags[job.promptId])) {
        return previous;
      }
      return previous.map((job) =>
        !job.musicVideo && tags[job.promptId]
          ? { ...job, musicVideo: tags[job.promptId] }
          : job,
      );
    });
  }, []);

  const recover = useCallback(
    (found: Record<string, { outputs: JobOutput[]; completedAt: number }>) => {
      setJobs((previous) =>
        previous.map((job) => {
          const hit = found[job.promptId];
          if (!hit || !(lostTrackOf(job) || job.recovered)) return job;
          return {
            ...job,
            phase: "done" as const,
            queuePosition: null,
            outputs: hit.outputs,
            completedAt: hit.completedAt,
            error: undefined,
            lostContact: undefined,
            recovered: true,
          };
        }),
      );
    },
    [],
  );

  return {
    jobs,
    activeCount: jobs.filter(isActive).length,
    estimateFor,
    submitting,
    submitError,
    submitErrorField,
    submit,
    tagMusicVideo,
    recover,
    recheckLost,
    cancel,
    remove,
    removeMany,
    toggleFavorite,
    clearFinished,
    dismissSubmitError,
  };
}

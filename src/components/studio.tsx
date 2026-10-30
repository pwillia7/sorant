"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ConnectionNotice,
  ConnectionPill,
  useHealth,
} from "@/components/connection-pill";
import { NotifyToggle } from "@/components/notify-toggle";
import { RewriteKeyButton } from "@/components/rewrite-key";
import { MusicVideoPanel } from "@/components/music-video-panel";
import { GenerationStage } from "@/components/generation-stage";
import { ParamForm } from "@/components/param-form";
import { SettingsModal } from "@/components/settings-modal";
import { ThemeToggle } from "@/components/theme-toggle";
import { TipsModal } from "@/components/tips-modal";
import { tipsFor } from "@/lib/workflows/tips";
import { TokenGate } from "@/components/token-gate";
import { ModelOptions } from "@/components/model-options";
import { TurboSwitch } from "@/components/turbo-switch";
import { patchSuppressed } from "@/lib/workflows/patches";
import { Button } from "@/components/ui/button";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { WorkflowPicker } from "@/components/workflow-picker";
import { UpdateBadge, useUpdates } from "@/components/update-badge";
import { StatusPanel } from "@/components/status-panel";
import { GenerationsPanel } from "@/components/generations-panel";
import { SorantMark } from "@/components/sorant-logo";
import { useJobs } from "@/hooks/use-jobs";
import { useMusicVideo } from "@/hooks/use-music-video";
import { useCompat } from "@/hooks/use-compat";
import { isActive, isRerunnable, isRetryable, type Job } from "@/lib/jobs";
import { restoreFrom } from "@/lib/restore";
import { api, ApiError, getToken } from "@/lib/client";
import {
  clampValues,
  hydrateAll,
  hydrateAlternateBase,
  hydrateLora,
  hydrateTier,
  hydratePatches,
  hydrateStrengths,
  hydrateTurbo,
  mergeWithDefaults,
  readStoredDirectorEngine,
  readStoredGatewayTier,
  readStoredLocalDirector,
  readStoredLowVram,
  readStoredRewriteModel,
  writeStoredDirectorEngine,
  writeStoredGatewayTier,
  writeStoredLocalDirector,
  writeStoredLowVram,
  writeStoredParams,
  writeStoredRewriteModel,
  writeStoredAlternateBase,
  writeStoredLora,
  writeStoredTier,
  writeStoredPatches,
  writeStoredStrengths,
  writeStoredTurbo,
} from "@/lib/param-storage";
import { workflowLabel } from "@/lib/workflows/modes";
import type { DirectorEngine } from "@/lib/workflows/local-director";
import {
  REWRITE_MODEL,
  tierParams,
  type GatewayTier,
} from "@/lib/workflows/rewrite-model";
import {
  compactReferenceSlots,
  isReferenceImage,
} from "@/lib/workflows/minimax-common";
import { effectiveWorkflow, TURBO_STRENGTH } from "@/lib/workflows/turbo";
import {
  CLIP_ACTIONS,
  defaultValuesFor,
  pinnedValues,
  type ClipAction,
  type ParamValue,
  type WorkflowSummary,
} from "@/lib/workflows/types";

interface ConfigPayload {
  authRequired: boolean;
  generationTimeoutSeconds: number;
}

/**
 * What the note above the form says once a file has been loaded into it. The
 * hand-offs leave the form in genuinely different states — Remix arrives with
 * the source's prompt in place, Extend arrives wanting a new one, Create video
 * arrives with a reference that is not the picture — so the note has to say
 * which of them happened.
 */
const CLIP_NOTICE: Record<ClipAction, { verb: string; detail: string }> = {
  musicvideo: {
    verb: "Making a music video for",
    detail:
      "The whole track is loaded as the song below. Say what the video is, add a picture of who is in it, then plan it — the scenes come back for you to read before anything renders.",
  },
  illustrate: {
    verb: "Scoring",
    detail:
      "The track is loaded as a reference below, and pins the run to 4 steps. Add a picture if you want one, say what should be on screen, then generate — the video is the length of its own control, not the track's.",
  },
  animate: {
    verb: "Animating",
    detail:
      "The picture is loaded as the first frame below. Say what happens from there, then generate.",
  },
  remix: {
    verb: "Remixing",
    detail:
      "The clip is loaded as the reference below — change anything you like, then generate.",
  },
  upscale: {
    verb: "Upscaling",
    detail:
      "The clip is loaded below at the default size and upscaler — generate when ready. With RTX Video a 15-second clip takes under a minute at 1080 px; SeedVR2 takes most of an hour.",
  },

  extend: {
    verb: "Extending",
    detail:
      "The clip is loaded below. Say what happens next, then generate — the result is the clip plus what you asked for.",
  },
};

/**
 * What a clip already showed, for a destination with a `storyParam`: the story
 * its own run was given, if it was made by that same hand-off, and then the
 * prompt that made it. So the third Extend in a chain still knows the first
 * prompt, not only the second.
 *
 * The earlier story counts only where that run's tail named its source — the
 * rule the workflow itself reads it by. A run on an upload kept whatever was
 * left in the hidden box, which describes some other clip.
 *
 * Over the control's limit, the first prompt is kept — it is the one that says
 * who and where — and the oldest Extend lines after it go.
 */
function storySoFar(
  job: Job,
  target: WorkflowSummary,
  storyParam: string,
): string {
  const { sourceParam, carriedParam } = target.clipTarget ?? {};
  const resolved = job.resolved ?? {};
  const earlier =
    sourceParam &&
    carriedParam &&
    resolved[sourceParam] &&
    resolved[carriedParam] === resolved[sourceParam]
      ? resolved[storyParam]
      : undefined;
  const lines = [
    ...(typeof earlier === "string" ? earlier.split("\n") : []),
    job.prompt,
  ]
    .map((line) => line.trim())
    .filter(Boolean);

  const param = target.params.find((p) => p.id === storyParam);
  const max = param && "maxLength" in param ? param.maxLength : undefined;
  while (max && lines.length > 2 && lines.join("\n").length > max) {
    lines.splice(1, 1);
  }
  const story = lines.join("\n");
  return max ? story.slice(0, max) : story;
}

type Boot =
  | { kind: "loading" }
  | { kind: "locked" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      workflows: WorkflowSummary[];
      timeoutSeconds: number;
      problems?: string[];
    };

export function Studio() {
  const [boot, setBoot] = useState<Boot>({ kind: "loading" });

  const load = useCallback(async () => {
    setBoot({ kind: "loading" });
    try {
      const config = await api<ConfigPayload>("/api/config");
      if (config.authRequired && !getToken()) {
        setBoot({ kind: "locked" });
        return;
      }

      const { workflows, problems } = await api<{
        workflows: WorkflowSummary[];
        problems?: string[];
      }>("/api/workflows");

      setBoot({
        kind: "ready",
        workflows,
        problems,
        timeoutSeconds: config.generationTimeoutSeconds,
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setBoot({ kind: "locked" });
        return;
      }
      setBoot({
        kind: "failed",
        message:
          cause instanceof ApiError
            ? cause.message
            : "Could not load workflows.",
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (boot.kind === "locked") return <TokenGate onUnlocked={load} />;

  if (boot.kind === "loading") {
    return (
      <main className="grid min-h-dvh place-items-center">
        <p className="text-[13px] text-fg-subtle">Loading…</p>
      </main>
    );
  }

  if (boot.kind === "failed") {
    return (
      <main className="grid min-h-dvh place-items-center p-6">
        <div className="max-w-sm text-center">
          <p className="text-sm font-medium text-fg">Could not start</p>
          <p className="mt-1 mb-5 text-[13px] leading-relaxed text-fg-muted">
            {boot.message}
          </p>
          <Button onClick={() => void load()}>Retry</Button>
        </div>
      </main>
    );
  }

  return (
    <Workbench workflows={boot.workflows} problems={boot.problems} />
  );
}

function Workbench({
  workflows: offered,
  problems,
}: {
  workflows: WorkflowSummary[];
  problems?: string[];
}) {
  const [selectedId, setSelectedId] = useState(offered[0]?.id ?? "");
  const jobs = useJobs();
  const health = useHealth();
  const compat = useCompat(
    health?.reachable === true && health.authorized !== false,
  );
  const updates = useUpdates();
  const [statusOpen, setStatusOpen] = useState(false);

  /**
   * Which kind of gateway key this browser says it holds, and the workflows as
   * that answer leaves them — the rewrite picker narrowed to the models a free
   * key can be spent on, everything else untouched.
   *
   * Read lazily for the same reason as the block below: Workbench only mounts
   * after the client-side load, so there is no server render to mismatch.
   *
   * Applied here rather than server-side because the key is not the install's:
   * two people pointed at the same ComfyUI can hold different ones, and the
   * app never sees either.
   */
  const [gatewayTier, setGatewayTier] = useState(readStoredGatewayTier);
  const workflows = useMemo(
    () =>
      offered.map((workflow) => ({
        ...workflow,
        params: tierParams(workflow.params, gatewayTier),
      })),
    [offered, gatewayTier],
  );

  // Both of these are read lazily rather than in an effect: Workbench only
  // mounts after the client-side load, so there is no server render to
  // mismatch, and an effect would flash the defaults first. Read together
  // because the values depend on the modes — a stored steps value is merged
  // against whichever range the mode it was saved under puts it in.
  const [initial] = useState(() => {
    const turbo = hydrateTurbo(workflows);
    return {
      turbo,
      patches: hydratePatches(workflows),
      values: hydrateAll(workflows, turbo),
    };
  });

  /** Which workflows are in turbo. Only ever keyed by ones that offer it. */
  const [turboByWorkflow, setTurboByWorkflow] = useState(initial.turbo);

  /**
   * Which single-node switches are on, per workflow. Kept apart from turbo
   * rather than folded into one map of mode objects because the two are
   * independent — Remix offers the patches and not turbo — and because turbo is
   * one boolean where this is a list.
   */
  const [patchesByWorkflow, setPatchesByWorkflow] = useState(initial.patches);

  /**
   * Turbo's low-VRAM path, for every workflow at once — it answers a question
   * about the GPU rather than about the shot, and the answer does not change
   * between graphs. Read lazily for the same reason as the modes above.
   */
  const [lowVram, setLowVram] = useState(readStoredLowVram);

  /**
   * Where the prompt rewrite runs, and on which local model when it is the
   * ComfyUI machine. For every workflow at once, like `lowVram`: it is about
   * the setup rather than the shot. See local-director.ts.
   */
  const [directorEngine, setDirectorEngine] = useState(
    readStoredDirectorEngine,
  );
  const [localDirector, setLocalDirector] = useState(readStoredLocalDirector);
  const onDirectorEngineChange = useCallback((engine: DirectorEngine) => {
    setDirectorEngine(engine);
    writeStoredDirectorEngine(engine);
  }, []);
  const onLocalDirectorChange = useCallback((id: string) => {
    setLocalDirector(id);
    writeStoredLocalDirector(id);
  }, []);
  /** What a run sends for it: a model id on a local run, nothing otherwise. */
  const runDirector = directorEngine === "local" ? localDirector : undefined;

  /**
   * How strong each switch that carries a strength is set. Keyed by patch id
   * and shared across workflows, because the VHS LoRA is the same LoRA on every
   * graph offering it — a strength found by eye on one is the answer on the
   * rest. Read lazily for the same reason as the modes above.
   */
  /**
   * Which LoRA each content switch is set to. Shared across workflows like the
   * two below: the list is the same list wherever it is offered.
   */
  const [lora, setLora] = useState(() => hydrateLora(workflows));

  /** Which graded trigger phrase each LoRA is set to, by entry id. */
  const [tier, setTier] = useState(() => hydrateTier(workflows));

  const [strengths, setStrengths] = useState(() => hydrateStrengths(workflows));

  /**
   * Which switches are on their alternate base. Shared across workflows for the
   * same reason as the strengths: it answers what this card can hold and what
   * has been downloaded onto it, not what this shot needs.
   */
  const [alternateBase, setAlternateBase] = useState(() =>
    hydrateAlternateBase(workflows),
  );

  // Values are kept per workflow so switching to compare settings and coming
  // back does not throw away what you typed, and persisted so a reload does
  // not either.
  const [valuesByWorkflow, setValuesByWorkflow] = useState<
    Record<string, Record<string, ParamValue>>
  >(initial.values);

  useEffect(() => {
    writeStoredParams(valuesByWorkflow);
  }, [valuesByWorkflow]);

  /**
   * Which gateway model writes the briefs, for every workflow — set in the
   * key's dialog beside where the rewrite runs, rather than on each form. Like
   * the local model: about the setup rather than the shot, so a retry or a
   * rerun goes out on today's choice and not the old run's. See `REWRITE_MODEL`.
   *
   * What it offers is the picker a workflow would have drawn: the live
   * catalog's, narrowed to the key's tier. Taken from a graph that shows its
   * director a picture where there is one, since that is the list that says
   * which models can see. A choice that list no longer has — retired, or
   * outside the tier — falls back to the first a form was left on, then to the
   * picker's default.
   */
  const rewritePicker = useMemo(() => {
    const pickers = workflows.flatMap((workflow) =>
      workflow.params.flatMap((param) =>
        param.id === REWRITE_MODEL && param.type === "select" ? [param] : [],
      ),
    );
    return pickers.find((param) => param.options.some((option) => option.group)) ?? pickers[0];
  }, [workflows]);
  const [chosenRewriteModel, setChosenRewriteModel] = useState(readStoredRewriteModel);
  const rewriteModel = useMemo(() => {
    if (!rewritePicker) return undefined;
    const offeredIds = new Set(rewritePicker.options.map((option) => option.value));
    const fromForms = Object.values(valuesByWorkflow).map((values) => values[REWRITE_MODEL]);
    const candidate = [chosenRewriteModel, ...fromForms, rewritePicker.default].find(
      (id): id is string => typeof id === "string" && offeredIds.has(id),
    );
    return candidate ?? rewritePicker.options[0]?.value;
  }, [rewritePicker, chosenRewriteModel, valuesByWorkflow]);
  const onRewriteModelChange = useCallback((id: string) => {
    setChosenRewriteModel(id);
    writeStoredRewriteModel(id);
  }, []);

  useEffect(() => {
    writeStoredTurbo(turboByWorkflow);
  }, [turboByWorkflow]);

  useEffect(() => {
    writeStoredPatches(patchesByWorkflow);
  }, [patchesByWorkflow]);

  useEffect(() => {
    writeStoredLowVram(lowVram);
  }, [lowVram]);

  useEffect(() => {
    writeStoredLora(lora);
  }, [lora]);

  useEffect(() => {
    writeStoredTier(tier);
  }, [tier]);

  useEffect(() => {
    writeStoredStrengths(strengths);
  }, [strengths]);

  useEffect(() => {
    writeStoredAlternateBase(alternateBase);
  }, [alternateBase]);

  // A clock that only ticks while something is running, so elapsed times
  // advance smoothly between poll results without re-rendering an idle page.
  const [now, setNow] = useState(() => Date.now());
  const hasActive = jobs.jobs.some(isActive);
  useEffect(() => {
    if (!hasActive) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasActive]);

  const picked = useMemo(
    () => workflows.find((workflow) => workflow.id === selectedId),
    [workflows, selectedId],
  );

  /**
   * The workflow whose modes a run of this one uses. Itself, except for the
   * music video, whose own graph only plans: its scenes are Reference to Video
   * runs, so Turbo and the switches are that workflow's, offered here and kept
   * under its id — the music video and Reference to Video share one setting,
   * because they are the same runs.
   */
  const modesFor = useMemo(
    () =>
      picked?.scenes
        ? workflows.find((workflow) => workflow.id === picked.scenes!.workflow)
        : picked,
    [picked, workflows],
  );
  const modeKey = modesFor?.id ?? selectedId;

  const turboOn = Boolean(turboByWorkflow[modeKey]);
  const patchesOn = useMemo(
    () => patchesByWorkflow[modeKey] ?? [],
    [patchesByWorkflow, modeKey],
  );
  const modes = useMemo(
    () => ({
      turbo: turboOn,
      patches: patchesOn,
      lora,
      tier,
      strengths,
      alternateBase,
    }),
    [turboOn, patchesOn, lora, tier, strengths, alternateBase],
  );

  /**
   * The workflow as the switch has it: same everything, except that turbo
   * retunes the steps control and carries its own estimate. Everything below
   * works from this rather than from the registry entry, so nothing else has
   * to know the mode exists.
   */
  const selected = useMemo(
    () => (picked ? effectiveWorkflow(picked, turboOn, modesFor ?? picked) : undefined),
    [picked, turboOn, modesFor],
  );
  /** `modesFor` as the switch has it, for everything that shows the modes. */
  const modesWorkflow = useMemo(
    () => (modesFor ? effectiveWorkflow(modesFor, turboOn) : undefined),
    [modesFor, turboOn],
  );

  const values = valuesByWorkflow[selectedId] ?? {};

  /**
   * The same values as the server will resolve them: a pinned control submits
   * its pinned value rather than whatever is stored under it, and anything
   * deciding what the run *is* — which switches its step count refuses — has to
   * read that number and not the stored one. See `pinnedValues`.
   */
  const runValues = useMemo(
    () => (selected ? pinnedValues(selected.params, values) : values),
    [selected, values],
  );

  /**
   * The modes as this run would actually have them, for everywhere a run is
   * *named* — the panel hint and the history entry. A switch the step count
   * refuses is still on and still remembered, but it is not part of what this
   * generation is, and naming it there would be the one place the app said so.
   * `modes` is what gets submitted, and stays what was asked for.
   */
  const runModes = useMemo(
    () => ({
      turbo: turboOn,
      patches: patchesOn.filter((id) => {
        const patch = modesWorkflow?.patches.find((candidate) => candidate.id === id);
        return !patch || !patchSuppressed(patch, runValues);
      }),
      lora,
      tier,
      strengths,
      alternateBase,
    }),
    [
      turboOn,
      patchesOn,
      modesWorkflow,
      runValues,
      lora,
      tier,
      strengths,
      alternateBase,
    ],
  );

  /**
   * Switching mode moves the steps range under a value that was valid in the
   * other one, so the values are brought back inside the new ranges as the
   * mode changes rather than left for the server to reject on submit.
   */
  const setTurbo = useCallback(
    (on: boolean) => {
      if (!modesFor?.turbo) return;
      setTurboByWorkflow((previous) => ({ ...previous, [modeKey]: on }));
      // The values whose ranges move are the ones of the workflow with the
      // steps control — and the music video's, whose steps control is the
      // scenes' and moves with it.
      setValuesByWorkflow((previous) => ({
        ...previous,
        [modeKey]: clampValues(
          effectiveWorkflow(modesFor, on),
          previous[modeKey] ?? {},
        ),
        ...(picked && picked.id !== modeKey
          ? {
              [picked.id]: clampValues(
                effectiveWorkflow(picked, on, modesFor),
                previous[picked.id] ?? {},
              ),
            }
          : {}),
      }));
    },
    [modesFor, modeKey, picked],
  );

  /**
   * Saying which kind of key this is re-narrows the rewrite picker, so every
   * workflow's stored model has to be checked against what it now offers.
   *
   * Every workflow rather than the selected one, unlike the turbo handler above:
   * the picker is on all of them, and a stored model that stopped being offered
   * would otherwise sit unnoticed until that workflow was next opened. See
   * `clampValues`, which is what drops it.
   */
  const onGatewayTierChange = useCallback(
    (tier: GatewayTier) => {
      setGatewayTier(tier);
      writeStoredGatewayTier(tier);
      setValuesByWorkflow((previous) => {
        const next = { ...previous };
        for (const workflow of offered) {
          const narrowed = {
            ...workflow,
            params: tierParams(workflow.params, tier),
          };
          next[workflow.id] = clampValues(
            effectiveWorkflow(narrowed, turboByWorkflow[workflow.id]),
            previous[workflow.id] ?? {},
          );
        }
        return next;
      });
    },
    [offered, turboByWorkflow],
  );

  /**
   * Nothing to clamp here, unlike turbo: a patch retunes no control, so turning
   * one on cannot leave a value outside a range.
   *
   * The stored list is rebuilt from the workflow's own order rather than by
   * appending, so it reads the same way the switches do and does not depend on
   * the order they were clicked.
   */
  const setPatch = useCallback(
    (id: string, on: boolean) => {
      if (!modesFor) return;
      setPatchesByWorkflow((previous) => {
        const current = previous[modeKey] ?? [];
        const wanted = on
          ? [...current, id]
          : current.filter((other) => other !== id);
        return {
          ...previous,
          [modeKey]: modesFor.patches
            .filter((patch) => wanted.includes(patch.id))
            .map((patch) => patch.id),
        };
      });
    },
    [modesFor, modeKey],
  );

  /**
   * Not per workflow, unlike the switch itself: what the number answers is how
   * strong this LoRA should be, which is the same question on every graph that
   * offers it. See `strengths`.
   */
  const setStrength = useCallback((id: string, value: number) => {
    setStrengths((previous) => ({ ...previous, [id]: value }));
  }, []);

  /** Not per workflow either, and for the same reason. See `alternateBase`. */
  const setAlternateBaseFor = useCallback((id: string, on: boolean) => {
    setAlternateBase((previous) => ({ ...previous, [id]: on }));
  }, []);

  /** Which LoRA a switch is set to. Keyed by the switch, unlike the rest. */
  const setLoraFor = useCallback((patchId: string, choiceId: string) => {
    setLora((previous) => ({ ...previous, [patchId]: choiceId }));
  }, []);

  const setTierFor = useCallback((choiceId: string, tierId: string) => {
    setTier((previous) => ({ ...previous, [choiceId]: tierId }));
  }, []);

  const setValue = useCallback(
    (id: string, value: ParamValue) => {
      setValuesByWorkflow((previous) => ({
        ...previous,
        [selectedId]: { ...previous[selectedId], [id]: value },
      }));
    },
    [selectedId],
  );

  /**
   * Swapping the clip out by hand ends the lineage — whatever is generated
   * next came from a different source, so claiming otherwise in the history
   * would be worse than showing nothing.
   */
  const onParamChange = useCallback(
    (id: string, value: ParamValue) => {
      if (selected?.clipTarget?.sourceParam === id) {
        setClipSource(null);
        setClipNotice(null);
      }

      // Clearing a reference picture closes its slot rather than leaving a hole
      // in the chain — see `compactReferenceSlots`, which is a no-op on every
      // graph that has no such slots and on every change that leaves no gap.
      if (selected && isReferenceImage(id)) {
        setValuesByWorkflow((previous) => ({
          ...previous,
          [selectedId]: compactReferenceSlots({
            ...(previous[selectedId] ?? {}),
            [id]: value,
          }),
        }));
        return;
      }

      setValue(id, value);
    },
    [selected, selectedId, setValue],
  );

  const resetToDefaults = useCallback(() => {
    if (!selected) return;
    // The persistence effect writes this straight back out, so the stored copy
    // is reset too rather than reappearing on the next load.
    setValuesByWorkflow((previous) => ({
      ...previous,
      [selectedId]: defaultValuesFor(selected),
    }));
  }, [selected, selectedId]);

  // Where each hand-off sends a finished clip, if anywhere. Found by
  // declaration rather than by id so the buttons follow whatever the registry
  // offers; first declaration of an action wins.
  const clipWorkflows = useMemo(() => {
    const byAction = new Map<ClipAction, WorkflowSummary>();
    for (const workflow of workflows) {
      const action = workflow.clipTarget?.action;
      if (action && !byAction.has(action)) byAction.set(action, workflow);
    }
    return byAction;
  }, [workflows]);

  // Paired with what each destination reads, so the result view can offer a
  // track's hand-offs on a track and a clip's on a clip.
  const offeredActions = useMemo(
    () =>
      CLIP_ACTIONS.flatMap((action) => {
        const target = clipWorkflows.get(action)?.clipTarget;
        return target ? [{ action, accepts: target.accepts }] : [];
      }),
    [clipWorkflows],
  );

  /** The hand-off whose copy is in flight, so only one runs at a time. */
  const [sending, setSending] = useState<ClipAction | null>(null);
  const [clipError, setClipError] = useState<string | null>(null);
  /** What was loaded and how, for the notice above the form. */
  const [clipNotice, setClipNotice] = useState<{
    action: ClipAction;
    label: string;
  } | null>(null);
  /**
   * Which generation the loaded clip came from, so the run it produces can be
   * shown under it in the history. Held past submit on purpose: three
   * variations on one remix are three children of the same source.
   */
  const [clipSource, setClipSource] = useState<{
    action: ClipAction;
    promptId: string;
  } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const settingsRef = useRef<HTMLElement>(null);

  /**
   * Send a finished generation into the workflow that takes it as a source —
   * Remix to rebuild a clip, Extend to carry on from one, Create video to build
   * a video around a track.
   *
   * The file itself is copied server-side (see /api/remix, which serves all
   * three): ComfyUI keeps outputs and loader inputs in separate directories, so
   * it has to move between them before a LoadVideo or LoadAudio node can see it.
   *
   * Nothing is submitted. This only fills the form in — the point is to open
   * the next generation ready to edit.
   */
  const sendClip = useCallback(
    async (job: Job, action: ClipAction) => {
      const target = clipWorkflows.get(action);
      if (!target?.clipTarget || sending) return;
      const { sourceParam, carry, fresh, carriedParam, storyParam } =
        target.clipTarget;

      const output = job.outputs[0];
      if (!output) return;

      setSending(action);
      setClipError(null);
      try {
        const { ref, tail } = await api<{ ref: string; tail?: string | null }>(
          "/api/remix",
          {
            method: "POST",
            body: JSON.stringify({
              filename: output.filename,
              subfolder: output.subfolder,
              type: output.type,
              // Only asked for where the destination can use it — the copy is
              // a history lookup and two more files.
              tailOf: carriedParam ? job.promptId : undefined,
            }),
          },
        );

        setValuesByWorkflow((previous) => {
          const next = {
            ...(fresh ? defaultValuesFor(target) : previous[target.id]),
            [sourceParam]: ref,
            // Cleared when this clip has none, so an earlier clip's tail is
            // not left in the slot. Extend would ignore it anyway — it only
            // takes a tail named after the clip it is given.
            ...(carriedParam ? { [carriedParam]: tail ?? "" } : {}),
            ...(storyParam
              ? { [storyParam]: storySoFar(job, target, storyParam) }
              : {}),
          };

          // Carry across whatever this destination asked for, so the new run
          // starts out matching the generation it came from rather than
          // reverting to whatever was last used here.
          for (const param of target.params) {
            if (!carry?.includes(param.id)) continue;
            const carried = job.resolved?.[param.id];
            // A type mismatch means the source workflow used the id for
            // something else — take the target's default over nonsense.
            if (carried === undefined) continue;
            if (typeof carried !== typeof param.default) continue;
            next[param.id] = carried;
          }

          return { ...previous, [target.id]: next };
        });

        setSelectedId(target.id);
        setClipNotice({
          action,
          label: job.prompt.trim() || job.workflowName,
        });
        setClipSource({ action, promptId: job.promptId });

        // On mobile the form sits above the stage the button was pressed in,
        // so without this the settings it just filled in are off-screen.
        if (window.matchMedia("(max-width: 1023px)").matches) {
          requestAnimationFrame(() =>
            settingsRef.current?.scrollIntoView({
              behavior: "smooth",
              block: "start",
            }),
          );
        }
      } catch (cause) {
        setClipError(
          cause instanceof ApiError
            ? cause.message
            : "Could not set that clip up as a source.",
        );
      } finally {
        setSending(null);
      }
    },
    [clipWorkflows, sending],
  );

  /**
   * Load a past generation's settings back into the form, and switch to the
   * workflow it was made with.
   *
   * What a run restores to is `restoreFrom`, which both this and `retry` read
   * — everything it was run with, checked against the workflow as it is today.
   *
   * Nothing is submitted. As with the clip hand-offs, this only fills the form
   * in and leaves the run to the user — `rerun` is the one that goes on to
   * press Generate, and it reads back what this filled in.
   */
  const reuseSettings = useCallback(
    (job: Job) => {
      const target = workflows.find(
        (workflow) => workflow.id === job.workflowId,
      );
      if (!target) return null;

      const restored = restoreFrom(job, target);

      // The seed is deliberately not restored. Reusing settings is how a take
      // gets varied; reproducing one exactly is a separate act with its own
      // button on the result, and rolling the seed back here would silently
      // pin every rerun to the old noise. Retry wants the opposite and keeps
      // it — see `retry`.
      const values = { ...restored.values };
      for (const param of target.params) {
        if (param.type === "seed") values[param.id] = param.default;
      }

      setValuesByWorkflow((previous) => ({ ...previous, [target.id]: values }));
      if (target.turbo) {
        setTurboByWorkflow((previous) => ({
          ...previous,
          [target.id]: restored.turbo,
        }));
      }
      setPatchesByWorkflow((previous) => ({
        ...previous,
        [target.id]: restored.patches,
      }));
      setLora((previous) => ({ ...previous, ...restored.lora }));
      setStrengths((previous) => ({ ...previous, ...restored.strengths }));
      setTier((previous) => ({ ...previous, ...restored.tier }));
      setAlternateBase((previous) => ({
        ...previous,
        ...restored.alternateBase,
      }));
      setSelectedId(target.id);

      // Same reason as the clip hand-off: on mobile the form sits above the
      // stage this was opened from, so the settings it just filled in would
      // otherwise be off-screen.
      if (window.matchMedia("(max-width: 1023px)").matches) {
        requestAnimationFrame(() =>
          settingsRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          }),
        );
      }
      return { target, restored, values };
    },
    [workflows],
  );

  const [tipsOpen, setTipsOpen] = useState(false);
  const tips = selected ? tipsFor(selected.id, modes) : undefined;

  // Which generation's settings are on screen, by id rather than by value: a
  // poll can replace the job object mid-view, and holding the object would
  // freeze the modal on a stale copy.
  const [settingsForId, setSettingsForId] = useState<string | null>(null);

  // Closing the panel when the workflow changes avoids showing one workflow's
  // advice under another's name.
  useEffect(() => {
    setTipsOpen(false);
  }, [selectedId]);

  /** Nothing to restore when the form already matches the defaults. */
  const isDefaults = useMemo(() => {
    if (!selected) return true;
    const defaults = defaultValuesFor(selected);
    return Object.keys(defaults).every((key) => values[key] === defaults[key]);
  }, [selected, values]);

  // Which generation the stage is showing. Follows the newest submission so a
  // fresh run takes over the canvas, but stays put if you pick an older one.
  const [viewedId, setViewedId] = useState<string | null>(null);
  const newestId = jobs.jobs[0]?.promptId ?? null;
  useEffect(() => {
    if (newestId) setViewedId(newestId);
  }, [newestId]);

  const viewedJob =
    jobs.jobs.find((job) => job.promptId === viewedId) ?? jobs.jobs[0] ?? null;

  // Resolved fresh each render, so the modal follows the job it is showing —
  // and closes itself if that entry is cleared from history while open.
  const settingsJob =
    jobs.jobs.find((job) => job.promptId === settingsForId) ?? null;

  /**
   * Which workflow the last submission was for.
   *
   * Only interesting because `retry` can submit one the form is not showing.
   * A refusal that names a control is shown on that control, and field ids are
   * not unique across workflows — `duration` is several of them — so without
   * this a retry of Reference to Video refused over its length would put the
   * message under Image to Video's length box, on a form that was not sent and
   * whose value is fine. Worse where the workflows share no such id: the
   * refusal would land on nothing at all and the retry would look like a
   * button that does nothing.
   */
  const [submittedFor, setSubmittedFor] = useState<string | null>(null);

  const fieldError = useMemo(() => {
    if (!jobs.submitError || !jobs.submitErrorField) return null;
    // Belongs to a form that is not on screen; the banner below takes it.
    if (submittedFor !== selectedId) return null;
    return { field: jobs.submitErrorField, message: jobs.submitError };
  }, [jobs.submitError, jobs.submitErrorField, submittedFor, selectedId]);

  /**
   * The music video's own state, when it is the workflow on screen. Always
   * mounted, so a render in progress keeps its project while another workflow
   * is being looked at.
   */
  // The stitch is a tool, so it is not in the list the browser is sent (see
  // the workflows route); a run needs only its id and how to name it.
  const stitchWorkflow = useMemo<WorkflowSummary | undefined>(
    () =>
      picked?.scenes
        ? {
            id: picked.scenes.stitch,
            name: picked.name,
            description: picked.description,
            hasAudio: true,
            tool: true,
            params: [],
            patches: [],
          }
        : undefined,
    [picked],
  );
  const musicVideo = useMusicVideo({
    workflow: picked?.scenes ? selected : undefined,
    sceneWorkflow: picked?.scenes ? modesWorkflow : undefined,
    stitchWorkflow,
    // Whichever workflow the Upscale button sends a clip to.
    upscaleWorkflow: picked?.scenes
      ? workflows.find((workflow) => workflow.clipTarget?.action === "upscale")
      : undefined,
    values,
    modes: { ...modes, lowVram, localDirector: runDirector, rewriteModel },
    jobs,
    online: health?.reachable === true && health.authorized !== false,
  });
  // The takes and upscales the music video is using, so its entry in the
  // history lists those and leaves the rest to the panel's take picker.
  const takesInUse = useMemo(
    () =>
      new Set(
        (musicVideo.project?.scenes ?? []).flatMap((scene) =>
          [scene.promptId, scene.upscalePromptId].filter(
            (id): id is string => Boolean(id),
          ),
        ),
      ),
    [musicVideo.project],
  );

  const submit = useCallback(() => {
    if (!selected || jobs.submitting) return;
    // The music video's button plans rather than generates; its renders are
    // started from its own panel, once the plan has been read.
    if (selected.scenes) {
      setSubmittedFor(selected.id);
      void musicVideo.plan();
      return;
    }
    setSubmittedFor(selected.id);
    void jobs.submit(selected, values, {
      ...modes,
      lowVram,
      localDirector: runDirector,
      rewriteModel,
      // Only meaningful on the workflow the clip was actually loaded into, and
      // only for the hand-off that put it there.
      derivedFrom:
        selected.clipTarget && clipSource?.action === selected.clipTarget.action
          ? clipSource.promptId
          : undefined,
    });
    // The form has been acted on, so the note explaining how it got filled in
    // has served its purpose.
    setClipNotice(null);
    // On mobile the stage sits below the whole settings panel, so submitting
    // from the pinned bar would otherwise give no visible sign of anything
    // happening. Desktop keeps the stage pinned alongside, so leave it alone.
    if (window.matchMedia("(max-width: 1023px)").matches) {
      requestAnimationFrame(() =>
        stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
  }, [selected, values, jobs, clipSource, modes, lowVram, runDirector, rewriteModel, musicVideo]);

  /**
   * Run a failed generation again, exactly as it was.
   *
   * The seed included, which is what separates this from `Reuse settings`. A
   * failure produced nothing, so there is no take to vary — the run the user
   * asked for never happened, and a retry that quietly rolled the noise would
   * be a different run wearing the same name.
   *
   * Submitted straight from the history, without touching the form. A retry is
   * "run that again", not "switch me to that": filling the form in would throw
   * away whatever is being worked on in it, and the run that comes back is a
   * new row at the top of this same list either way.
   *
   * `lowVram` and where the brief is written are taken from the session rather
   * than the run — properties of the setup rather than of the take, where the
   * current answer is the better guess.
   *
   * `derivedFrom` is carried across so a retried hand-off stays in the family
   * it came from rather than appearing as an unrelated entry beside it.
   *
   * Nothing here is clever about *why* it failed. A run that died because the
   * rewrite model refused the shot needs a different model, chosen in the
   * key's dialog — and the retry then goes out on it, since the model is the
   * session's like the local director. The other kind of failure is the box
   * offline, out of memory, something fallen over between here and there.
   */
  const retry = useCallback(
    (job: Job) => {
      if (jobs.submitting) return;
      const target = workflows.find(
        (workflow) => workflow.id === job.workflowId,
      );
      if (!target) return;

      setSubmittedFor(target.id);
      const restored = restoreFrom(job, target);
      void jobs.submit(target, restored.values, {
        turbo: restored.turbo,
        patches: restored.patches,
        lora: restored.lora,
        strengths: restored.strengths,
        tier: restored.tier,
        alternateBase: restored.alternateBase,
        lowVram,
        localDirector: runDirector,
        rewriteModel,
        derivedFrom: job.derivedFrom,
        musicVideo: job.musicVideo,
      });

      // On mobile the stage sits below the whole settings panel, so a retry
      // fired from the history would otherwise give no visible sign of
      // anything happening. Same reason as `submit`.
      if (window.matchMedia("(max-width: 1023px)").matches) {
        requestAnimationFrame(() =>
          stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
        );
      }
    },
    [jobs, workflows, lowVram, runDirector, rewriteModel],
  );

  /**
   * Run a finished generation again: its settings loaded into its workflow's
   * form, then submitted, with a fresh seed.
   *
   * `Reuse settings` and Generate in one press, and deliberately the form's
   * route rather than `retry`'s. A take that worked is one worth another take
   * of — the noise rolled, everything else as it was — and the form is left
   * showing what was run, so the next tweak starts from there rather than from
   * whatever the form happened to hold. That a rerun takes the form over is the
   * point of it here, where for a failure it would be in the way.
   *
   * Submitted from the values `reuseSettings` worked out rather than from the
   * form: the state it just set has not rendered yet, so `submit` would send
   * the workflow and values that were on screen before the press.
   */
  const rerun = useCallback(
    (job: Job) => {
      if (jobs.submitting) return;
      const loaded = reuseSettings(job);
      if (!loaded) return;
      const { target, restored, values } = loaded;

      setSubmittedFor(target.id);
      void jobs.submit(target, values, {
        turbo: restored.turbo,
        patches: restored.patches,
        lora: restored.lora,
        strengths: restored.strengths,
        tier: restored.tier,
        alternateBase: restored.alternateBase,
        lowVram,
        localDirector: runDirector,
        rewriteModel,
        derivedFrom: job.derivedFrom,
        musicVideo: job.musicVideo,
      });
      setClipNotice(null);

      // `reuseSettings` scrolled to the form on mobile; the run is what there
      // is to see now, and it is on the stage.
      if (window.matchMedia("(max-width: 1023px)").matches) {
        requestAnimationFrame(() =>
          stageRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
        );
      }
    },
    [jobs, reuseSettings, lowVram, runDirector, rewriteModel],
  );

  /** Withheld where the workflow that made the run is no longer registered. */
  const rerunnable = useCallback(
    (job: Job) =>
      isRerunnable(job) &&
      workflows.some((workflow) => workflow.id === job.workflowId),
    [workflows],
  );

  /** Withheld where the workflow that made the run is no longer registered. */
  const retryable = useCallback(
    (job: Job) =>
      isRetryable(job) &&
      workflows.some((workflow) => workflow.id === job.workflowId),
    [workflows],
  );

  // Cmd/Ctrl+Enter from anywhere fires the run. Held in a ref so the listener
  // is attached once rather than on every keystroke in the prompt box.
  const submitRef = useRef(submit);
  useEffect(() => {
    submitRef.current = submit;
  }, [submit]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Named after what the selected workflow actually makes: pressing "Generate
  // video" and getting an mp3 is a small lie the app was telling.
  const queueLabel = selected?.scenes
    ? musicVideo.project
      ? "Plan again"
      : "Plan the video"
    : jobs.activeCount > 0
      ? `Queue another (${jobs.activeCount} running)`
      : `Generate ${selected?.makes ?? "video"}`;
  const planning =
    musicVideo.step === "cutting" || musicVideo.step === "planning";

  return (
    /* At lg the shell is exactly the viewport and nothing outside a column
       scrolls, so the height is pinned rather than a minimum — a fractional
       dvh would otherwise leave the document a pixel taller than the window
       and grow a page scrollbar with nowhere to go. */
    <div className="min-h-dvh lg:h-dvh lg:overflow-hidden">
      <header
        className="sticky top-0 z-20 border-b border-border-default
          bg-bg/80 backdrop-blur-md"
      >
        <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-2 px-4 sm:gap-3 sm:px-5">
          {/* Decorative: the h1 beside it says the name, and a mark that
              announced it too would have a screen reader read it twice. */}
          <SorantMark aria-hidden="true" className="size-7 shrink-0 text-fg" />
          <h1 className="text-[13px] font-medium tracking-[-0.01em] text-fg">
            {/* Live text rather than the drawn wordmark, so it stays Geist and
                stays selectable. The apostrophe carries the accent — the one
                piece of colour in the header, and the thing the name turns on. */}
            Soran<span className="text-accent">’</span>t
          </h1>
          {/* Secondary label: the first thing to go when space is tight. */}
          <span className="hidden text-[13px] text-fg-subtle sm:inline">
            / ComfyUI
          </span>

          <div className="ml-auto flex shrink-0 items-center gap-2">
            <UpdateBadge info={updates.info} onOpen={() => setStatusOpen(true)} />
            <ConnectionPill
              health={health}
              onOpen={() => setStatusOpen(true)}
              update={updates.info?.latest?.version}
            />
            <RewriteKeyButton
              tier={gatewayTier}
              onTierChange={onGatewayTierChange}
              engine={directorEngine}
              onEngineChange={onDirectorEngineChange}
              localDirector={localDirector}
              onLocalDirectorChange={onLocalDirectorChange}
              rewritePicker={rewritePicker}
              rewriteModel={rewriteModel}
              onRewriteModelChange={onRewriteModelChange}
            />
            <NotifyToggle />
            <ThemeToggle />
          </div>
        </div>
      </header>

      {/* pb-24 on mobile keeps the sticky action bar from covering the last
          control; the bar is not rendered at lg, so the padding goes away.

          At lg this stops being a page that scrolls and becomes a shell that
          does not: a column exactly one viewport tall, less the 56px header
          above it. Each of the two tracks inside then scrolls on its own, so
          the one under the pointer is the one that moves. Below lg it is an
          ordinary block and the document scrolls as before. */}
      <main
        className="mx-auto max-w-[1400px] px-4 pb-24 pt-5 sm:px-5 lg:flex
          lg:h-[calc(100dvh_-_3.5rem)] lg:flex-col lg:overflow-hidden lg:pb-6 lg:pt-6"
      >
        <ConnectionNotice health={health} />
        {problems?.length ? (
          <div
            className="mb-5 shrink-0 rounded-lg border border-warning/40 bg-warning/5
              p-3 text-[12px] leading-relaxed text-warning"
          >
            <p className="font-medium">
              A workflow definition looks out of sync with its graph:
            </p>
            <ul className="mt-1 list-inside list-disc font-mono">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {/*
          minmax(0,1fr) rather than 1fr: a flexible track's automatic minimum
          is min-content, so the widest unwrappable thing in the column sets a
          floor the track cannot go below. The history list is full of them —
          every entry's prompt line is `truncate`, which is white-space:nowrap,
          so its min-content is the whole prompt however long it runs. One long
          prompt was widening this track past the page and scrolling the
          document sideways. Capping the minimum at 0 lets the ellipsis do the
          job it was there for.
        */}
        {/*
          The form column is the one being worked in — Reference to Video puts
          26 controls in it — while the right-hand track holds one video and a
          list. It used to stop at 380px and hand the rest to the stage, which
          left the controls in a third of the width and the preview in two
          thirds. It grows to 460 now, and at a wide enough viewport to 520,
          where the extra goes to the column that has something to put in it.
        */}
        <div
          className="grid gap-5 lg:min-h-0 lg:flex-1
            lg:grid-cols-[minmax(340px,460px)_minmax(0,1fr)]
            2xl:grid-cols-[minmax(400px,520px)_minmax(0,1fr)]"
        >
          {/* min-w-0: a grid item defaults to min-width:auto and would grow
              past its track to fit wide content such as an image preview.

              overscroll-contain so that reaching the end of this column stops
              there rather than handing the leftover scroll to the page. */}
          <div
            className="scroll-pane flex min-w-0 flex-col gap-5 lg:h-full lg:min-h-0
              lg:overflow-y-auto lg:overscroll-contain lg:pr-2"
          >
            <Panel className="rise" padded>
              <PanelHeader
                title="Workflow"
                hint="Preconfigured graphs on the ComfyUI instance."
              />
              <WorkflowPicker
                workflows={workflows}
                turbo={turboByWorkflow}
                patches={patchesByWorkflow}
                compat={compat}
                selectedId={selectedId}
                onSelect={(id) => {
                  // Choosing a workflow by hand supersedes whatever Remix or
                  // Extend set up, so the note about it goes.
                  setClipNotice(null);
                  setClipSource(null);
                  setSelectedId(id);
                }}
              />
            </Panel>

            {selected ? (
              <Panel
                ref={settingsRef}
                className="rise scroll-mt-20"
                style={{ "--delay": "80ms" } as CSSProperties}
                padded
              >
                <PanelHeader
                  title="Settings"
                  hint={workflowLabel(
                    selected.name,
                    runModes,
                    modesWorkflow?.patches ?? selected.patches,
                  )}
                  action={
                    <div className="flex shrink-0 items-center gap-2">
                      {tips ? (
                        <Button
                          variant="quiet"
                          size="xs"
                          onClick={() => setTipsOpen(true)}
                        >
                          Tips
                        </Button>
                      ) : null}
                      <Button
                        variant="quiet"
                        size="xs"
                        onClick={resetToDefaults}
                        disabled={isDefaults}
                        title={
                          isDefaults
                            ? "Already at the defaults"
                            : "Put every setting on this workflow back to its default"
                        }
                      >
                        Restore defaults
                      </Button>
                    </div>
                  }
                />
                {modesWorkflow?.turbo ? (
                  <TurboSwitch
                    turbo={modesWorkflow.turbo}
                    on={turboOn}
                    onChange={setTurbo}
                    strength={strengths[TURBO_STRENGTH]}
                    onStrengthChange={(value) =>
                      setStrength(TURBO_STRENGTH, value)
                    }
                  />
                ) : null}

                <ModelOptions
                  patches={modesWorkflow?.patches ?? []}
                  on={patchesOn}
                  values={runValues}
                  onPatchChange={setPatch}
                  turbo={modesWorkflow?.turbo}
                  turboOn={turboOn}
                  lowVram={lowVram}
                  onLowVramChange={setLowVram}
                  strengths={strengths}
                  onStrengthChange={setStrength}
                  alternateBase={alternateBase}
                  onAlternateBaseChange={setAlternateBaseFor}
                  lora={lora}
                  onLoraChange={setLoraFor}
                  tier={tier}
                  onTierChange={setTierFor}
                />

                {clipNotice &&
                selected.clipTarget?.action === clipNotice.action ? (
                  <div
                    className="mb-5 flex items-start gap-3 rounded-lg border border-accent/40
                      bg-accent-subtle/30 p-3 text-[12px] leading-relaxed text-fg-muted"
                  >
                    <span className="min-w-0 flex-1">
                      {CLIP_NOTICE[clipNotice.action].verb}{" "}
                      <span className="text-fg">“{clipNotice.label}”</span>.{" "}
                      {CLIP_NOTICE[clipNotice.action].detail}
                    </span>
                    <Button
                      variant="quiet"
                      size="xs"
                      className="shrink-0"
                      onClick={() => setClipNotice(null)}
                    >
                      Dismiss
                    </Button>
                  </div>
                ) : null}

                {/* Deliberately never disabled: a running generation should not
                    stop you setting up the next one. */}
                <ParamForm
                  // Per workflow: two graphs can share a param id — Upscale
                  // and Extend both call their clip `source_video` — and a
                  // control kept across the switch keeps its local state, so
                  // one workflow's upload error would show on the other's.
                  key={selected.id}
                  // The rewrite model is chosen for the whole app, in the
                  // key's dialog; see `rewriteModel`.
                  params={selected.params.filter((param) => param.id !== REWRITE_MODEL)}
                  values={values}
                  onChange={onParamChange}
                  fieldError={fieldError}
                />
              </Panel>
            ) : null}
          </div>

          <div
            ref={stageRef}
            /* min-w-0 for the same reason as the left column: without it this
               grid item takes min-width:auto and grows past its track.

               This was `lg:sticky lg:top-20`, which is what made the two
               columns take turns: a sticky box taller than the viewport pins
               its top and leaves its bottom off-screen until the whole grid
               has finished scrolling, so the history below the stage could not
               be reached until the settings column had run out. It scrolls
               itself now instead. */
            className="flex min-w-0 scroll-mt-20 flex-col gap-4 lg:h-full lg:min-h-0"
          >
            {/* On mobile this lives in the pinned bar at the bottom instead,
                so the primary action is never a scroll away. On desktop it sits
                outside the scroller below, so it stays put while the stage and
                the history move under it. */}
            <div className="hidden shrink-0 items-center gap-3 lg:flex">
              <Button
                variant="primary"
                size="lg"
                onClick={submit}
                loading={jobs.submitting || (Boolean(selected?.scenes) && planning)}
                disabled={!selected}
                className="flex-1 sm:flex-none sm:min-w-44"
              >
                {queueLabel}
              </Button>
              <span className="hidden text-[12px] text-fg-subtle lg:block">
                or press{" "}
                <kbd
                  className="rounded border border-border-default bg-bg-subtle
                    px-1.5 py-0.5 font-mono text-[11px]"
                >
                  ⌘↵
                </kbd>
              </span>
            </div>

            <div
              className="scroll-pane flex min-w-0 flex-col gap-4 lg:min-h-0 lg:flex-1
                lg:overflow-y-auto lg:overscroll-contain lg:pr-2"
            >
              {jobs.submitError &&
              (!jobs.submitErrorField || submittedFor !== selectedId) ? (
                <div
                  className="flex items-start gap-3 rounded-lg border border-danger/40
                    bg-danger/5 p-3 text-[13px] leading-relaxed text-danger"
                >
                  <span className="min-w-0 flex-1">{jobs.submitError}</span>
                  <Button
                    variant="danger"
                    size="xs"
                    className="shrink-0"
                    onClick={jobs.dismissSubmitError}
                  >
                    Dismiss
                  </Button>
                </div>
              ) : null}

              {clipError ? (
                <div
                  className="flex items-start gap-3 rounded-lg border border-danger/40
                    bg-danger/5 p-3 text-[13px] leading-relaxed text-danger"
                >
                  <span className="min-w-0 flex-1">{clipError}</span>
                  <Button
                    variant="danger"
                    size="xs"
                    className="shrink-0"
                    onClick={() => setClipError(null)}
                  >
                    Dismiss
                  </Button>
                </div>
              ) : null}

              {selected?.scenes ? <MusicVideoPanel video={musicVideo} /> : null}

              <GenerationStage
                job={viewedJob}
                now={now}
                estimateSeconds={viewedJob ? jobs.estimateFor(viewedJob) : null}
                onCancel={(promptId) => void jobs.cancel(promptId)}
                onReuseSeed={(seed) => setValue("seed", seed)}
                clipActions={offeredActions}
                onClipAction={
                  offeredActions.length > 0
                    ? (job, action) => void sendClip(job, action)
                    : undefined
                }
                onShowSettings={
                  viewedJob
                    ? () => setSettingsForId(viewedJob.promptId)
                    : undefined
                }
                onToggleFavorite={jobs.toggleFavorite}
                onRetry={viewedJob && retryable(viewedJob) ? retry : undefined}
                onRerun={viewedJob && rerunnable(viewedJob) ? rerun : undefined}
                retrying={jobs.submitting}
                busyAction={sending}
              />

              <Panel padded>
                <PanelHeader
                  title="Generations"
                  hint={
                    jobs.jobs.length > 0
                      ? `${jobs.jobs.length} on this device`
                      : undefined
                  }
                />
                <GenerationsPanel
                  jobs={jobs.jobs}
                  selectedId={viewedJob?.promptId ?? null}
                  now={now}
                  onSelect={setViewedId}
                  onCancel={(promptId) => void jobs.cancel(promptId)}
                  onRemove={jobs.remove}
                  onRemoveMany={jobs.removeMany}
                  onToggleFavorite={jobs.toggleFavorite}
                  onClearFinished={jobs.clearFinished}
                  onRetry={retry}
                  canRetry={retryable}
                  onRerun={rerun}
                  canRerun={rerunnable}
                  retrying={jobs.submitting}
                  inUse={takesInUse}
                />
              </Panel>
            </div>
          </div>
        </div>
      </main>

      {/* Mobile action bar. The settings panel runs to a dozen-plus controls,
          so an inline Generate button sits well below the fold — pinning it
          keeps the primary action reachable from anywhere on the page. */}
      <div
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border-default
          bg-bg/90 px-4 pt-3 backdrop-blur-md lg:hidden"
        style={{
          // Clear the iOS home indicator without adding dead space elsewhere.
          paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
        }}
      >
        <Button
          variant="primary"
          size="lg"
          onClick={submit}
          loading={jobs.submitting || (Boolean(selected?.scenes) && planning)}
          disabled={!selected}
          className="w-full"
        >
          {queueLabel}
        </Button>
      </div>

      {tips && selected ? (
        <TipsModal
          open={tipsOpen}
          onClose={() => setTipsOpen(false)}
          title={workflowLabel(selected.name, runModes, selected.patches)}
          tips={tips}
        />
      ) : null}

      <StatusPanel
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
        health={health}
        compat={compat}
        updates={updates}
        workflows={offered}
      />

      {settingsJob ? (
        <SettingsModal
          open
          onClose={() => setSettingsForId(null)}
          job={settingsJob}
          workflow={workflows.find(
            (workflow) => workflow.id === settingsJob.workflowId,
          )}
          // Withheld when the workflow that made this run is no longer
          // registered: there is nothing to load the settings into, and a
          // button that cannot work is worse than no button.
          onReuse={
            workflows.some(
              (workflow) => workflow.id === settingsJob.workflowId,
            )
              ? reuseSettings
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ConnectionNotice,
  ConnectionPill,
  useHealth,
} from "@/components/connection-pill";
import { NotifyToggle } from "@/components/notify-toggle";
import { RewriteKeyButton } from "@/components/rewrite-key";
import { MusicVideoPanel } from "@/components/music-video-panel";
import { LongSwapPanel } from "@/components/long-swap-panel";
import { GenerationStage } from "@/components/generation-stage";
import { ParamForm } from "@/components/param-form";
import { SettingsModal } from "@/components/settings-modal";
import { ThemeToggle } from "@/components/theme-toggle";
import { PalettePicker } from "@/components/palette-picker";
import { TipsModal } from "@/components/tips-modal";
import { tipsFor } from "@/lib/workflows/tips";
import { TokenGate } from "@/components/token-gate";
import { ModelOptions } from "@/components/model-options";
import { TurboSwitch } from "@/components/turbo-switch";
import { patchSuppressed } from "@/lib/workflows/patches";
import { Button } from "@/components/ui/button";
import { MachineNote, WorkflowCards, WorkflowMenu } from "@/components/workflow-picker";
import { Dock, SettingsPanel } from "@/components/dock";
import { Feed } from "@/components/feed";
import { Viewer } from "@/components/viewer";
import { workflowIcon } from "@/components/workflow-icons";
import { UpdateBadge, useUpdates } from "@/components/update-badge";
import { StatusPanel } from "@/components/status-panel";
import { SorantMark } from "@/components/sorant-logo";
import { useJobs } from "@/hooks/use-jobs";
import { useMusicVideo } from "@/hooks/use-music-video";
import { useLongSwap } from "@/hooks/use-long-swap";
import { useCompat } from "@/hooks/use-compat";
import { isActive, isRerunnable, isRetryable, lostTrackOf, type Job } from "@/lib/jobs";
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
  readStoredDirectorEngine,
  readStoredLocalDirector,
  readStoredLowVram,
  readStoredRewriteModel,
  writeStoredDirectorEngine,
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
import { QualityFold, runSummary } from "./run-bar";
import { formatEstimate, runEstimate } from "@/lib/workflows/estimate";
import { CHAIN_OVER_SECONDS, estimateScale, SPLIT_OVER_SECONDS, SPLIT_SHOTS_PARAM } from "@/lib/workflows/slices";
import type { DirectorEngine } from "@/lib/workflows/local-director";
import { REWRITE_MODEL } from "@/lib/workflows/rewrite-model";
import {
  compactReferenceSlots,
  isReferenceImage,
} from "@/lib/workflows/minimax-common";
import { effectiveWorkflow, TURBO_STRENGTH } from "@/lib/workflows/turbo";
import {
  CLIP_ACTIONS,
  defaultValuesFor,
  paramVisible,
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
/**
 * What a long Character swap's segments are joined with. The stitch is a
 * tool, so it is not in the list the browser is sent (see the workflows
 * route); a run needs only its id.
 */
const SWAP_STITCH: WorkflowSummary = {
  id: "multi-scene-stitch",
  name: "Character swap",
  description: "Joins a long Character swap's segments.",
  hasAudio: true,
  tool: true,
  params: [],
  patches: [],
};

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
  swap: {
    verb: "Swapping a character into",
    detail:
      "The clip is loaded below. Add a picture of the character, say who in the clip they replace, then generate.",
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

  if (boot.kind === "loading") return <StudioSkeleton />;

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
  workflows,
  problems,
}: {
  workflows: WorkflowSummary[];
  problems?: string[];
}) {
  const [selectedId, setSelectedId] = useState(workflows[0]?.id ?? "");
  const jobs = useJobs();
  const health = useHealth();
  const comfyOnline = health?.reachable === true && health.authorized !== false;
  const compat = useCompat(comfyOnline);

  // Catch up with runs this device lost track of whenever ComfyUI starts
  // answering — on load, and each time the connection comes back. Most of
  // them finished while nobody was looking. See `applyRecheck`.
  const { recheckLost } = jobs;
  useEffect(() => {
    if (comfyOnline) void recheckLost();
  }, [comfyOnline, recheckLost]);
  const updates = useUpdates();
  const [statusOpen, setStatusOpen] = useState(false);

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
   *
   * Until someone chooses, the local director — unless the machine has been
   * asked and has no local model at all, when a run there could only fail.
   * Before the machine answers it is local too: a run sent then that cannot
   * find the file says so and names the way back.
   *
   * The model is the one chosen while the machine has it, and otherwise the
   * best one it does have — a choice made against a machine that has since
   * lost the file, or never had it, is not one a run can keep.
   */
  const [chosenEngine, setChosenEngine] = useState(readStoredDirectorEngine);
  const [chosenLocalDirector, setLocalDirector] = useState(readStoredLocalDirector);
  const installedDirectors = compat?.localDirectors ?? null;
  const localDirector =
    installedDirectors && !installedDirectors.includes(chosenLocalDirector)
      ? (installedDirectors[0] ?? chosenLocalDirector)
      : chosenLocalDirector;
  const directorEngine: DirectorEngine =
    chosenEngine ?? (installedDirectors?.length === 0 ? "gateway" : "local");
  const onDirectorEngineChange = useCallback((engine: DirectorEngine) => {
    setChosenEngine(engine);
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
   * catalog's. Taken from a graph that shows its director a picture where
   * there is one, since that is the list that says which models can see. A
   * choice that list no longer has — retired since — falls back to the
   * picker's default, as does no choice at all: the forms' stored values are
   * the old default written back on every load, not something anyone chose.
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
    const candidate = [chosenRewriteModel, rewritePicker.default].find(
      (id): id is string => typeof id === "string" && offeredIds.has(id),
    );
    return candidate ?? rewritePicker.options[0]?.value;
  }, [rewritePicker, chosenRewriteModel]);
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
   * The two surfaces over the gallery: the settings panel, and the viewer with
   * one generation open in it. Neither is a place the page navigates to — the
   * gallery stays where it is underneath.
   *
   * `showTab` is what the actions that move attention call. "create" means the
   * form was just filled in (a hand-off, reused settings), so the settings
   * open on it; "result" means a run was just sent, so whatever was over the
   * gallery gets out of the way and its top, where the new tile is, comes
   * into view.
   */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewerId, setViewerId] = useState<string | null>(null);
  const showTab = useCallback((tab: "create" | "result") => {
    setViewerId(null);
    if (tab === "create") {
      setSettingsOpen(true);
      return;
    }
    // A phone's settings cover the page; a wide screen's sit beside it.
    if (window.matchMedia("(max-width: 1279px)").matches) setSettingsOpen(false);
    requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }, []);

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

        // On a phone the button was pressed on the Result tab; the settings
        // it just filled in are on Create.
        showTab("create");
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

      // Same reason as the clip hand-off: on a phone the settings it just
      // filled in are on another tab from the one this was opened on.
      showTab("create");
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

  // The generation open in the viewer, by id so a poll replacing the object
  // keeps it current, and so removing it closes the viewer.
  const viewedJob = jobs.jobs.find((job) => job.promptId === viewerId) ?? null;

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
  // What a multi-scene video's scenes run as when they have nothing to build
  // from, in the same modes as the rest. See `scenes.bare`.
  const bareSceneWorkflow = useMemo(() => {
    const bare = workflows.find((workflow) => workflow.id === picked?.scenes?.bare);
    return bare ? effectiveWorkflow(bare, turboOn) : undefined;
  }, [workflows, picked, turboOn]);
  // One for each kind, both always mounted, so each keeps its own project
  // while the other is on screen. Only the one on screen is handed the
  // workflows it submits to.
  const plannedOptions = (kind: "music" | "story") => {
    const active = picked?.scenes?.kind === kind;
    return {
      kind,
      workflow: active ? selected : undefined,
      sceneWorkflow: active ? modesWorkflow : undefined,
      bareSceneWorkflow: active ? bareSceneWorkflow : undefined,
      stitchWorkflow: active ? stitchWorkflow : undefined,
      // Whichever workflow the Upscale button sends a clip to.
      upscaleWorkflow: active
        ? workflows.find((workflow) => workflow.clipTarget?.action === "upscale")
        : undefined,
      values,
      modes: { ...modes, lowVram, localDirector: runDirector, rewriteModel },
      jobs,
      online: health?.reachable === true && health.authorized !== false,
    };
  };
  const musicVideoKind = useMusicVideo(plannedOptions("music"));
  const multiScene = useMusicVideo(plannedOptions("story"));
  // A Character swap of a clip past CHAIN_OVER_SECONDS, sent as a chain of
  // run and joined here. Always mounted, so a swap in progress keeps going
  // while another workflow is on screen. See use-long-swap.ts.
  const swapWorkflow = workflows.find((workflow) => workflow.slicedBy !== undefined);
  const longSwap = useLongSwap({
    workflow: swapWorkflow,
    stitchWorkflow: SWAP_STITCH,
    upscaleWorkflow: workflows.find((workflow) => workflow.clipTarget?.action === "upscale"),
    jobs,
  });
  /** The planned video on screen, or the music video's when neither is. */
  const musicVideo = picked?.scenes?.kind === "story" ? multiScene : musicVideoKind;
  // The takes and upscales the music video is using, so its entry in the
  // history lists those and leaves the rest to the panel's take picker.
  const takesInUse = useMemo(
    () =>
      new Set(
        [...(musicVideoKind.project?.scenes ?? []), ...(multiScene.project?.scenes ?? [])].flatMap((scene) =>
          [scene.promptId, scene.upscalePromptId].filter(
            (id): id is string => Boolean(id),
          ),
        ),
      ),
    [musicVideoKind.project, multiScene.project],
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
    // Too long for one run: a chain of segment runs, joined at the end.
    // Split at its camera cuts, which the chain's panel finds first; with
    // none, a short clip still goes as one run.
    const clipSeconds = selected.slicedBy ? Number(values[selected.slicedBy]) : 0;
    if (
      selected.slicedBy &&
      (clipSeconds > CHAIN_OVER_SECONDS || (values[SPLIT_SHOTS_PARAM] !== false && clipSeconds >= SPLIT_OVER_SECONDS))
    ) {
      void longSwap.start(values, { ...modes, lowVram, localDirector: runDirector, rewriteModel });
      setClipNotice(null);
      showTab("result");
      return;
    }
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
    // On a phone the run shows on the Result tab, and submitting from the
    // form would otherwise give no visible sign of anything happening.
    showTab("result");
  }, [selected, values, jobs, clipSource, modes, lowVram, runDirector, rewriteModel, musicVideo, longSwap]);

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

      // A retry fired from the history shows on the Result tab. Same reason
      // as `submit`.
      showTab("result");
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

      // `reuseSettings` went to the form on a phone; the run is what there is
      // to see now, and it is on Result.
      showTab("result");
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

  // The form, split in two: what the run is, and how it is made. See
  // QualityFold. The rewrite model is chosen for the whole app, in the key's
  // dialog; see `rewriteModel`.
  const formParams = (selected?.params ?? []).filter((param) => param.id !== REWRITE_MODEL);
  const howParams = formParams.filter((param) => param.group === "Sampling");
  const whatParams = formParams.filter((param) => param.group !== "Sampling");
  const stepsValue = runValues.steps ?? howParams.find((param) => param.id === "steps")?.default;
  const qualitySummary = [
    modesWorkflow?.turbo ? (turboOn ? "Turbo" : "Standard") : null,
    ...(modesWorkflow?.patches ?? [])
      .filter((patch) => patchesOn.includes(patch.id))
      .map((patch) => patch.label),
    stepsValue !== undefined ? `${stepsValue} steps` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const summary = selected
    ? runSummary(selected, values, {
        turbo: Boolean(modesWorkflow?.turbo) && turboOn,
        // A planned video's time is a scene count times a scene's, unknown
        // until it is planned.
        estimate: selected.scenes
          ? undefined
          : scaledEstimate(
              runEstimate(modesFor ?? selected, turboOn, patchesOn),
              estimateScale(selected.slicedBy, values),
            ),
      })
    : "";

  /** Choosing a workflow by hand supersedes whatever a hand-off set up. */
  const selectWorkflow = (id: string) => {
    setClipNotice(null);
    setClipSource(null);
    setSelectedId(id);
  };

  const [menuOpen, setMenuOpen] = useState(false);

  /**
   * Opens the settings, and where a field is named, brings it into view and
   * gives it a moment's highlight — the dock's attachment chips land here.
   */
  const openSettings = useCallback((fieldId?: string) => {
    if (!fieldId) {
      setSettingsOpen((open) => !open);
      return;
    }
    setSettingsOpen(true);
    window.setTimeout(() => {
      const element = document.getElementById(`param-${fieldId}`);
      const field = element?.closest("fieldset > *") ?? element;
      field?.scrollIntoView({ block: "center", behavior: "smooth" });
      if (field instanceof HTMLElement) {
        field.animate(
          [{ backgroundColor: "var(--accent-subtle)" }, { backgroundColor: "transparent" }],
          { duration: 1400, easing: "ease-out" },
        );
      }
    }, 320);
  }, []);

  // A refusal naming a control the dock does not show opens the panel on it.
  useEffect(() => {
    if (fieldError?.field && fieldError.field !== "prompt") openSettings(fieldError.field);
  }, [fieldError, openSettings]);

  const SelectedIcon = selected ? workflowIcon(selected.id) : null;
  const runEstimateSeconds = selected && !selected.scenes
    ? scaledEstimate(
        runEstimate(modesFor ?? selected, turboOn, patchesOn),
        estimateScale(selected.slicedBy, values),
      )
    : undefined;

  // The dock carries the prompt; the panel carries everything else.
  const promptParam = whatParams.find(
    (param) => param.id === "prompt" && (param.type === "textarea" || param.type === "text"),
  );
  const panelParams = promptParam ? whatParams.filter((param) => param !== promptParam) : whatParams;
  const attachments = whatParams
    .filter(
      (param) =>
        (param.type === "image" || param.type === "video" || param.type === "audio") &&
        !param.advanced &&
        paramVisible(param, values),
    )
    .map((param) => ({
      param,
      set: typeof values[param.id] === "string" && values[param.id] !== "",
      required: "required" in param && Boolean(param.required),
    }))
    // Every required slot, every filled one, and the first empty optional one
    // as the way to add more — Reference to Video has seven slots, and seven
    // empty chips would be the dock.
    .filter((chip, index, all) =>
      chip.required || chip.set || all.findIndex((other) => !other.required && !other.set) === index,
    );

  const workflowList = {
    workflows,
    turbo: turboByWorkflow,
    patches: patchesByWorkflow,
    compat,
    selectedId,
    onSelect: selectWorkflow,
  };

  // The viewer steps through the gallery in its own order, newest first.
  const stepViewer = (direction: -1 | 1) => {
    const index = jobs.jobs.findIndex((job) => job.promptId === viewerId);
    const next = jobs.jobs[index + direction];
    if (next) setViewerId(next.promptId);
  };

  const dockNotice =
    jobs.submitError && (!jobs.submitErrorField || submittedFor !== selectedId) ? (
      <Alert tone="danger" onDismiss={jobs.dismissSubmitError}>
        {jobs.submitError}
      </Alert>
    ) : clipError ? (
      <Alert tone="danger" onDismiss={() => setClipError(null)}>
        {clipError}
      </Alert>
    ) : selected && clipNotice && selected.clipTarget?.action === clipNotice.action ? (
      <Alert tone="accent" onDismiss={() => setClipNotice(null)}>
        {CLIP_NOTICE[clipNotice.action].verb} <span className="text-fg">“{clipNotice.label}”</span>.{" "}
        {CLIP_NOTICE[clipNotice.action].detail}
      </Alert>
    ) : null;

  return (
    <div className="relative min-h-dvh">
      <header className="sticky top-0 z-50 flex h-12 items-center gap-2 border-b border-border-default bg-bg/90 px-3 backdrop-blur-md sm:gap-3 sm:px-5">
        <SorantMark aria-hidden="true" className="size-6 shrink-0 text-fg" />
        <h1 className="display-tight text-[17px] font-bold text-fg">
          Soran<span className="text-accent">’</span>t
        </h1>
        {jobs.activeCount > 0 ? (
          <span className="hidden items-center gap-1.5 rounded-md bg-accent-subtle px-2 py-1 sm:flex">
            <span aria-hidden="true" className="size-1.5 rounded-full bg-accent breathe" />
            <span className="font-mono text-[11px] tabular-nums text-fg">{jobs.activeCount} running</span>
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          <UpdateBadge info={updates.info} onOpen={() => setStatusOpen(true)} />
          <ConnectionPill health={health} onOpen={() => setStatusOpen(true)} update={updates.info?.latest?.version} />
          <RewriteKeyButton
            engine={directorEngine}
            onEngineChange={onDirectorEngineChange}
            localDirector={localDirector}
            onLocalDirectorChange={onLocalDirectorChange}
            installedDirectors={installedDirectors}
            rewritePicker={rewritePicker}
            rewriteModel={rewriteModel}
            onRewriteModelChange={onRewriteModelChange}
          />
          <NotifyToggle />
          <PalettePicker />
          <ThemeToggle />
        </div>
      </header>

      <ConnectionNotice health={health} />
      {problems?.length ? (
        <div className="border-b border-warning/40 bg-warning/10 px-5 py-2.5 text-[12px] leading-relaxed text-warning">
          <p className="font-semibold">A workflow definition looks out of sync with its graph:</p>
          <ul className="mt-1 list-inside list-disc font-mono">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* The gallery. Room at the foot for the dock, and beside it on a wide
          screen for the settings while they are open. */}
      <main
        className={`mx-auto w-full max-w-[1800px] px-4 pb-64 pt-6 transition-[padding] duration-300 sm:px-8 sm:pt-8
          ${settingsOpen ? "xl:pr-[476px]" : ""}`}
      >
        {selected?.scenes || (selected?.slicedBy && longSwap.project) ? (
          <section aria-label={selected.name} className="mb-10">
            {selected.scenes ? <MusicVideoPanel video={musicVideo} /> : null}
            {selected.slicedBy && longSwap.project ? <LongSwapPanel swap={longSwap} /> : null}
          </section>
        ) : null}

        <Feed
          jobs={jobs.jobs}
          now={now}
          estimateFor={jobs.estimateFor}
          onOpen={setViewerId}
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
          empty={
            <div className="mx-auto max-w-6xl pt-4 sm:pt-10">
              <h2 className="display-tight max-w-2xl text-[40px] font-semibold leading-[1.05] text-fg sm:text-[56px]">
                What do you want to make?
              </h2>
              <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-fg-muted">
                Pick one, describe it below, and press Generate. Everything you make lands here, and keeps
                rendering on your machine if you close the tab.
              </p>
              <div className="mt-10">
                <WorkflowCards {...workflowList} />
              </div>
            </div>
          }
        />
      </main>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title={
          selected && SelectedIcon ? (
            <div className="flex items-start gap-3">
              <SelectedIcon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-accent" />
              <div className="min-w-0">
                <h2 className="display-tight text-[19px] font-semibold leading-tight text-fg">{selected.name}</h2>
                <p className="mt-0.5 text-[12px] leading-snug text-fg-muted">{selected.description}</p>
              </div>
            </div>
          ) : (
            "Settings"
          )
        }
      >
        {selected ? (
          <>
            <MachineNote status={compat?.workflows[selected.id]} className="mb-4" />
            <div className="mb-6 flex flex-wrap items-center gap-2">
              {runEstimateSeconds ? (
                <span className="mr-auto flex items-baseline gap-1.5">
                  <span className="label-caps text-fg-subtle">Runs</span>
                  <span className="font-mono text-[12px] tabular-nums text-fg">~{formatEstimate(runEstimateSeconds)}</span>
                </span>
              ) : (
                <span className="mr-auto" />
              )}
              {tips ? (
                <Button variant="quiet" size="xs" onClick={() => setTipsOpen(true)}>
                  Guide
                </Button>
              ) : null}
              <Button
                variant="quiet"
                size="xs"
                onClick={resetToDefaults}
                disabled={isDefaults}
                title={isDefaults ? "Already at the defaults" : "Put every setting on this workflow back to its default"}
              >
                Restore defaults
              </Button>
            </div>

            {/* Deliberately never disabled: a running generation should not
                stop you setting up the next one. Keyed per workflow, since two
                graphs can share a param id and a control keeps local state. */}
            <ParamForm
              key={selected.id}
              params={panelParams}
              values={values}
              onChange={onParamChange}
              fieldError={fieldError}
            />

            {modesWorkflow?.turbo || (modesWorkflow?.patches.length ?? 0) > 0 || howParams.length > 0 ? (
              <QualityFold summary={qualitySummary}>
                {modesWorkflow?.turbo ? (
                  <TurboSwitch
                    turbo={modesWorkflow.turbo}
                    on={turboOn}
                    onChange={setTurbo}
                    strength={strengths[TURBO_STRENGTH]}
                    onStrengthChange={(value) => setStrength(TURBO_STRENGTH, value)}
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
                <ParamForm
                  key={`${selected.id}-how`}
                  params={howParams}
                  values={values}
                  onChange={onParamChange}
                  fieldError={fieldError}
                />
              </QualityFold>
            ) : null}
          </>
        ) : null}
      </SettingsPanel>

      <div className={`transition-[padding] duration-300 ${settingsOpen ? "xl:[&>div]:pr-[476px]" : ""}`}>
        <Dock
          menu={<WorkflowMenu {...workflowList} open={menuOpen} onOpenChange={setMenuOpen} />}
          prompt={promptParam}
          promptValue={promptParam ? values[promptParam.id] : undefined}
          onPromptChange={(value) => promptParam && onParamChange(promptParam.id, value)}
          promptError={fieldError?.field === "prompt" ? fieldError.message : undefined}
          attachments={attachments}
          summary={summary}
          onOpenSettings={openSettings}
          settingsOpen={settingsOpen}
          notice={dockNotice}
          onSubmit={submit}
          submitLabel={queueLabel}
          busy={jobs.submitting || (Boolean(selected?.scenes) && planning)}
          disabled={!selected}
          description={selected?.description}
          onOpenGuide={tips ? () => setTipsOpen(true) : undefined}
        />
      </div>

      <Viewer
        job={viewedJob}
        now={now}
        onClose={() => setViewerId(null)}
        onStep={jobs.jobs.length > 1 ? stepViewer : undefined}
      >
        <GenerationStage
          job={viewedJob}
          now={now}
          estimateSeconds={viewedJob ? jobs.estimateFor(viewedJob) : null}
          onCancel={(promptId) => void jobs.cancel(promptId)}
          onReuseSeed={(seed) => {
            setValue("seed", seed);
            showTab("create");
          }}
          clipActions={offeredActions}
          onClipAction={offeredActions.length > 0 ? (job, action) => void sendClip(job, action) : undefined}
          onShowSettings={viewedJob ? () => setSettingsForId(viewedJob.promptId) : undefined}
          onToggleFavorite={jobs.toggleFavorite}
          onRetry={viewedJob && retryable(viewedJob) ? retry : undefined}
          onCheckAgain={viewedJob && lostTrackOf(viewedJob) ? () => jobs.recheckLost([viewedJob.promptId]) : undefined}
          onRerun={viewedJob && rerunnable(viewedJob) ? rerun : undefined}
          retrying={jobs.submitting}
          busyAction={sending}
        />
      </Viewer>

      {tips && selected ? (
        <TipsModal
          open={tipsOpen}
          onClose={() => setTipsOpen(false)}
          title={selected.name}
          subtitle={workflowLabel(selected.name, runModes, selected.patches)}
          tips={tips}
        />
      ) : null}

      <StatusPanel
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
        health={health}
        compat={compat}
        updates={updates}
        workflows={workflows}
      />

      {settingsJob ? (
        <SettingsModal
          open
          onClose={() => setSettingsForId(null)}
          job={settingsJob}
          workflow={workflows.find((workflow) => workflow.id === settingsJob.workflowId)}
          // Withheld when the workflow that made this run is gone.
          onReuse={
            workflows.some((workflow) => workflow.id === settingsJob.workflowId)
              ? (job) => {
                  const loaded = reuseSettings(job);
                  setSettingsForId(null);
                  return loaded;
                }
              : undefined
          }
        />
      ) : null}
    </div>
  );
}

/** A note over the dock: a refusal, a failed hand-off, or how a hand-off filled it in. */
function Alert({
  children,
  onDismiss,
  tone,
}: {
  children: React.ReactNode;
  onDismiss: () => void;
  tone: "danger" | "accent";
}) {
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-xl border bg-raised/95 py-2.5 pl-3.5 pr-2 text-[12px] leading-relaxed text-fg-muted
        shadow-md backdrop-blur-md ${tone === "danger" ? "border-danger/60" : "border-accent/60"}`}
    >
      <span aria-hidden="true" className={`mt-1.5 size-1.5 shrink-0 rounded-full ${tone === "danger" ? "bg-danger" : "bg-accent"}`} />
      <span className="min-w-0 flex-1">{children}</span>
      <Button variant="quiet" size="xs" className="shrink-0" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  );
}

/** The page's shape while the workflows load: the bar, a gallery, the dock. */
function StudioSkeleton() {
  const block = "rounded-xl bg-bg-subtle motion-safe:animate-pulse";
  return (
    <div className="min-h-dvh" aria-busy="true" aria-label="Loading">
      <div className="h-12 border-b border-border-default" />
      <div className="mx-auto grid max-w-[1800px] gap-5 px-4 pt-8 sm:grid-cols-2 sm:px-8 xl:grid-cols-3 2xl:grid-cols-4">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className={`${block} aspect-video`} />
        ))}
      </div>
      <div className="fixed inset-x-0 bottom-5 px-3">
        <div className={`${block} mx-auto h-28 max-w-3xl`} />
      </div>
    </div>
  );
}

/** A run's estimate times the slices a long clip is cut into. See slices.ts. */
function scaledEstimate(seconds: number | undefined, scale: number): number | undefined {
  return seconds === undefined ? undefined : Math.round(seconds * scale);
}

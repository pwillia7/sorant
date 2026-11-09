import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import { pickSubject, samStage, swapParams } from "./minimax-h3-swap";
import {
  CHECK_RECOVERED_COLOR,
  CHECK_SECONDS_PARAM,
  CHECK_START_PARAM,
  CHECK_TRACKED_COLOR,
  MASK_CHECK_ID,
  MAX_CHECK_SECONDS,
  PICK_PARAM,
  SUBJECT_BOX_PARAM,
} from "./subject-box";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";

/**
 * Who a Character swap would replace, shown before it runs.
 *
 * The swap's SAM stage alone — the same nodes, by the same names, with the
 * same pick (`pickSubject`) — on the stretch of clip a run would start on, at
 * 0.5 MP. Seconds, where the swap is many minutes, and it is the swap's mask
 * that decides who is changed: H3 Relay's own instructions say to inspect it
 * before rendering (docs/person-remover-v1.md).
 *
 * The result is the clip with the mask painted on: green where SAM tracked the
 * person it was given, red where the track dropped and "Find them again"
 * re-picked by the description and rule. Red on someone else is a swap of the
 * wrong person for those frames.
 *
 * Not in the picker: the swap's form, shot planner and redo panel run it.
 */

/** 0.5 MP: Prepare Source's smaller budget, so nothing is scaled after it. */
const CHECK_MEGAPIXELS = 0.5;

const colorNumber = (hex: string) => Number.parseInt(hex.slice(1), 16);
const TRACKED_COLOR = colorNumber(CHECK_TRACKED_COLOR);
const RECOVERED_COLOR = colorNumber(CHECK_RECOVERED_COLOR);
const TINT = 0.55;

const shared = (id: string): ParamDef => {
  const param = swapParams.find((candidate) => candidate.id === id);
  if (!param) throw new Error(`The swap has no "${id}" control.`);
  return param;
};

const graph: ComfyGraph = {
  ...samStage(),
  // Frames only as many as the clip has: Prepare Source pads its IMAGE out to
  // H3's grid, which the check has no use for.
  frames: {
    class_type: "ImageFromBatch",
    inputs: { image: ["prepare", 0], batch_index: 0, length: ["prepare", 5] },
    _meta: { title: "The clip's own frames" },
  },
  size: {
    class_type: "GetImageSize",
    inputs: { image: ["prepare", 0] },
    _meta: { title: "Get Image Size" },
  },
  tint: {
    class_type: "SolidMask",
    inputs: { value: TINT, width: ["size", 0], height: ["size", 1] },
    _meta: { title: "How strongly the mask is painted" },
  },
  // What the track itself followed, before any re-pick.
  tracked_tint: {
    class_type: "MaskComposite",
    inputs: { destination: ["mask", 0], source: ["tint", 0], x: 0, y: 0, operation: "multiply" },
    _meta: { title: "Tracked (tinted)" },
  },
  // What Recover Masks added on frames the track had lost.
  recovered: {
    class_type: "MaskComposite",
    inputs: { destination: ["recover", 0], source: ["mask", 0], x: 0, y: 0, operation: "subtract" },
    _meta: { title: "Re-picked by the rule" },
  },
  recovered_tint: {
    class_type: "MaskComposite",
    inputs: { destination: ["recovered", 0], source: ["tint", 0], x: 0, y: 0, operation: "multiply" },
    _meta: { title: "Re-picked (tinted)" },
  },
  green: {
    class_type: "EmptyImage",
    inputs: { width: ["size", 0], height: ["size", 1], batch_size: 1, color: TRACKED_COLOR },
    _meta: { title: "Green" },
  },
  red: {
    class_type: "EmptyImage",
    inputs: { width: ["size", 0], height: ["size", 1], batch_size: 1, color: RECOVERED_COLOR },
    _meta: { title: "Red" },
  },
  paint_tracked: {
    class_type: "ImageCompositeMasked",
    inputs: { destination: ["frames", 0], source: ["green", 0], x: 0, y: 0, resize_source: false, mask: ["tracked_tint", 0] },
    _meta: { title: "Paint the tracked person" },
  },
  paint_recovered: {
    class_type: "ImageCompositeMasked",
    inputs: {
      destination: ["paint_tracked", 0],
      source: ["red", 0],
      x: 0,
      y: 0,
      resize_source: false,
      mask: ["recovered_tint", 0],
    },
    _meta: { title: "Paint the re-picked frames" },
  },
  video: {
    class_type: "CreateVideo",
    inputs: { images: ["paint_recovered", 0], fps: 24 },
    _meta: { title: "Create Video" },
  },
  save: {
    class_type: "SaveVideo",
    inputs: {
      video: ["video", 0],
      filename_prefix: "swap_check/check",
      format: "mp4",
      "format.codec": "h264",
      "format.codec.encoding": "re-encode",
      "format.codec.encoding.crf": 23,
    },
    _meta: { title: "Save Video" },
  },
};
graph.prepare.inputs.resolution = "480";
graph.prepare.inputs.duration_seconds = 0;
graph.first_frame.inputs.image = ["prepare", 0];
graph.track.inputs.images = ["prepare", 0];
graph.recover.inputs.images = ["prepare", 0];

const params: ParamDef[] = [
  shared("source_video"),
  {
    id: "prompt",
    label: "Who to replace",
    type: "text",
    default: "",
    maxLength: 200,
    targets: [
      {
        node: "subject",
        input: "text",
        transform: (value) =>
          String(value ?? "")
            .trim()
            .replace(/[.\s]+$/, "")
            .replace(/^(the|a|an)\s+/i, "") || "person",
      },
    ],
  },
  shared(PICK_PARAM),
  shared(SUBJECT_BOX_PARAM),
  shared("lost_frames"),
  shared("sam_threshold"),
  {
    id: CHECK_START_PARAM,
    label: "From",
    type: "number",
    default: 0,
    min: 0,
    max: 600,
    step: 0.001,
    targets: [{ node: "segment_slice", input: "start_time" }],
  },
  {
    id: CHECK_SECONDS_PARAM,
    label: "For",
    type: "number",
    default: MAX_CHECK_SECONDS,
    min: 0.5,
    max: MAX_CHECK_SECONDS,
    step: 0.001,
    targets: [{ node: "segment_slice", input: "duration" }],
  },
];

export const swapMaskCheck: WorkflowDef = {
  id: MASK_CHECK_ID,
  name: "Check who SAM picks",
  description: "Shows who a Character swap would replace, painted on the clip.",
  estimatedSeconds: 45,
  graph,
  params,
  tool: true,
  finalize(graph, values: Record<string, ParamValue>) {
    if (!String(values.source_video ?? "")) throw new ParamError("Choose a clip first.", "source_video");
    pickSubject(graph, values, CHECK_MEGAPIXELS);
    // "Stop with an error" is the swap's to do: here the lost frames are shown
    // unpainted, which says the same and more.
    // A name of the run's own, so a check never lands on another's file.
    graph.save.inputs.filename_prefix = `swap_check/check_${crypto.randomUUID().slice(0, 8)}`;
  },
  finalizeCases: [
    {
      name: "the description and rule",
      values: { source_video: "clip.mp4", prompt: "man in a red shirt", [PICK_PARAM]: "leftmost" },
    },
    {
      name: "a box, partway into the clip",
      values: {
        source_video: "clip.mp4",
        [SUBJECT_BOX_PARAM]: '{"x":0.4,"y":0.1,"w":0.25,"h":0.85,"sw":1280,"sh":720}',
        [CHECK_START_PARAM]: 12.5,
        [CHECK_SECONDS_PARAM]: 6,
      },
    },
    {
      name: "points on them and on someone to leave out",
      values: {
        source_video: "clip.mp4",
        [SUBJECT_BOX_PARAM]: '{"in":[[0.5,0.3],[0.5,0.6]],"out":[[0.2,0.5]],"sw":1920,"sh":1080}',
        lost_frames: "recover",
      },
    },
  ],
};

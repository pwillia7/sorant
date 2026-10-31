import {
  Clapperboard,
  Disc3,
  FastForward,
  Image,
  ImagePlay,
  Music,
  Scaling,
  Shuffle,
  Type,
  UserRound,
  WandSparkles,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * How each workflow is drawn wherever it is named: the picker, the history,
 * the run summary. By id, so a workflow added without one still shows, under
 * the generic mark.
 */
const ICONS: Record<string, LucideIcon> = {
  "minimax-h3": Type,
  "minimax-h3-image": Image,
  "minimax-h3-i2v": ImagePlay,
  "minimax-h3-ref": UserRound,
  "minimax-h3-ref2v": Shuffle,
  "minimax-h3-extend": FastForward,
  upscale: Scaling,
  "music-video": Disc3,
  "multi-scene": Clapperboard,
  "minimax-music3": Music,
  "image-edit": WandSparkles,
};

export const workflowIcon = (id: string): LucideIcon => ICONS[id] ?? Workflow;

/**
 * The picker's sections, by what someone is trying to do. A workflow in none
 * of them is listed under the last heading.
 */
export const WORKFLOW_GROUPS: Array<{ title: string; ids: string[] }> = [
  {
    title: "Make something new",
    ids: ["minimax-h3", "minimax-h3-image", "minimax-h3-i2v", "minimax-h3-ref"],
  },
  { title: "Work on a clip you made", ids: ["minimax-h3-ref2v", "minimax-h3-extend", "upscale"] },
  { title: "Long videos, scene by scene", ids: ["music-video", "multi-scene"] },
  { title: "Sound", ids: ["minimax-music3"] },
];

import type { ComfyGraph } from "@/lib/comfy";
import { ParamError } from "@/lib/params";
import type { ParamDef, ParamValue, WorkflowDef } from "./types";

/**
 * Joins a music video's scenes and lays the song over them, on the box.
 *
 * Core ComfyUI does this without decoding the scenes into memory:
 * `ConcatenateVideo` joins encoded clips as they are, `VideoTrim` cuts each to
 * its window, and `complete_audio` replaces the scenes' own sound with one
 * read of the song from the top — so there is no seam in the audio however
 * the picture is cut. A song's worth of scenes as decoded frames would be tens
 * of gigabytes; this is a remux and a few short trims.
 *
 * Every scene came back on H3's frame grid, a little longer than its window,
 * so each is trimmed to its window before the join, and the scenes then tile
 * the song exactly.
 *
 * The scenes are read where they were saved — `LoadVideo` takes an
 * `[output]`-annotated name — so nothing is copied first.
 *
 * Not in the picker: the music video's panel queues it once every scene is
 * done. See src/lib/music-video/.
 */

const SONG_NODE = "song";
const SONG_TRIM_NODE = "song_trim";
const JOIN_NODE = "join";
const LIST_NODE = "scenes";

/** As many clips as one `ConcatenateVideo` takes. */
const CLIPS_PER_JOIN = 100;

/**
 * The most scenes a join takes. One `ConcatenateVideo` takes 100, so past that
 * the scenes are joined in groups and the groups joined (`wireJoin`). A long
 * Character swap split at its camera cuts passed 100 segments (2026-11-24).
 */
export const MAX_SCENES = 1000;

/**
 * Feeds `clips` into the join node, in order. Up to 100 go straight in; past
 * that, each run of 100 goes into a `ConcatenateVideo` of its own, and those
 * into the join. That costs nothing: a join fed a join takes over its list of
 * files (`VideoFromList` flattens a nested one), so the whole thing is still
 * one remux of the original clips. The groups carry no `complete_audio` — the
 * outer join's, when it has one, covers everything.
 */
function wireJoin(graph: ComfyGraph, clips: [string, number][]) {
  if (clips.length <= CLIPS_PER_JOIN) {
    clips.forEach((clip, index) => {
      graph[JOIN_NODE].inputs[`videos.video${index}`] = clip;
    });
    return;
  }
  for (let start = 0, group = 0; start < clips.length; start += CLIPS_PER_JOIN, group++) {
    const part = `${JOIN_NODE}_part_${group}`;
    const inputs: Record<string, unknown> = { codec: "auto" };
    clips.slice(start, start + CLIPS_PER_JOIN).forEach((clip, index) => {
      inputs[`videos.video${index}`] = clip;
    });
    graph[part] = {
      class_type: "ConcatenateVideo",
      inputs,
      _meta: { title: `Concatenate Video (scenes ${start + 1}–${Math.min(start + CLIPS_PER_JOIN, clips.length)})` },
    };
    graph[JOIN_NODE].inputs[`videos.video${group}`] = [part, 0];
  }
}

export interface StitchScene {
  /** The clip, as `LoadVideo` reads it: "video/name.mp4 [output]". */
  file: string;
  /** How much of it to keep, from its first frame. */
  seconds: number;
  /**
   * Another clip whose sound this scene carries instead of its own, for a
   * multi-scene join. See `multiSceneStitch`.
   */
  sound?: string;
  /**
   * Where this scene starts in the join's `soundtrack`, in seconds: its sound
   * is that stretch of it. See `multiSceneStitch`.
   */
  from?: number;
}

/**
 * A clip someone uploaded, in the input folder, by the name they gave it —
 * which may have anything in it ("#", brackets, "⧸"), so only what could
 * reach outside the folder is refused. ComfyUI checks it is there.
 */
function isSourceName(file: string): boolean {
  return (
    /\.(mp4|webm|mov|mkv|m4v)$/i.test(file) &&
    !file.includes("..") &&
    !file.startsWith("/") &&
    !file.includes("\\") &&
    !/[\u0000-\u001f]/.test(file)
  );
}

/** A name in output or input, nothing that climbs out of either. */
function isClipName(file: string): boolean {
  return /^[\w\-./ ]+\.(mp4|webm|mov|mkv)( \[(output|input)\])?$/i.test(file) && !file.includes("..");
}

/** The scene list as the browser sends it. */
export function parseScenes(value: ParamValue | undefined): StitchScene[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value ?? "[]"));
  } catch {
    throw new ParamError("The scene list is not readable.", "scenes");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ParamError("There are no scenes to join.", "scenes");
  }
  if (parsed.length > MAX_SCENES) {
    throw new ParamError(`At most ${MAX_SCENES} scenes can be joined.`, "scenes");
  }
  return parsed.map((scene) => {
    const file = String((scene as StitchScene)?.file ?? "");
    const seconds = Number((scene as StitchScene)?.seconds);
    const sound = (scene as StitchScene)?.sound;
    const from = (scene as StitchScene)?.from;
    if (!isClipName(file) || (sound !== undefined && !isClipName(String(sound)))) {
      throw new ParamError("One of the scenes is not a clip this can join.", "scenes");
    }
    if (!(seconds > 0)) {
      throw new ParamError("One of the scenes has no length.", "scenes");
    }
    if (from !== undefined && !(Number(from) >= 0)) {
      throw new ParamError("One of the scenes starts before its soundtrack does.", "scenes");
    }
    return {
      file,
      seconds,
      ...(sound !== undefined ? { sound: String(sound) } : {}),
      ...(from !== undefined ? { from: Number(from) } : {}),
    };
  });
}

const graph: ComfyGraph = {
  // The list itself, kept as text in the graph: nothing reads it at run time —
  // `finalize` builds a loader and a trim per scene from it — but it is how the
  // history records what was joined.
  [LIST_NODE]: {
    class_type: "PrimitiveStringMultiline",
    inputs: { value: "[]" },
    _meta: { title: "Scenes" },
  },
  [SONG_NODE]: {
    class_type: "LoadAudio",
    inputs: { audio: "" },
    _meta: { title: "Load Audio (song)" },
  },
  [SONG_TRIM_NODE]: {
    class_type: "TrimAudioDuration",
    inputs: { audio: [SONG_NODE, 0], start_index: 0, duration: 60 },
    _meta: { title: "Trim Audio Duration (the song, to the video)" },
  },
  [JOIN_NODE]: {
    class_type: "ConcatenateVideo",
    inputs: { codec: "auto", complete_audio: [SONG_TRIM_NODE, 0] },
    _meta: { title: "Concatenate Video" },
  },
  save: {
    class_type: "SaveVideo",
    inputs: {
      video: [JOIN_NODE, 0],
      filename_prefix: "video/music_video",
      format: "auto",
      codec: "auto",
    },
    _meta: { title: "Save Video" },
  },
};

const params: ParamDef[] = [
  {
    id: "scenes",
    label: "Scenes",
    type: "textarea",
    default: "[]",
    // About 100 characters a scene, with room for long names.
    maxLength: MAX_SCENES * 300,
    group: "Scenes",
    targets: [{ node: LIST_NODE, input: "value" }],
  },
  {
    id: "song",
    label: "Song",
    type: "audio",
    default: "",
    required: true,
    group: "Scenes",
    targets: [{ node: SONG_NODE, input: "audio" }],
  },
  {
    id: "song_seconds",
    label: "Song length",
    type: "number",
    default: 60,
    min: 1,
    max: 3600,
    step: 0.001,
    unit: "sec",
    group: "Scenes",
    targets: [{ node: SONG_TRIM_NODE, input: "duration" }],
  },
];

export const musicVideoStitch: WorkflowDef = {
  id: "music-video-stitch",
  name: "Music video",
  description: "Joins a music video's scenes and lays the song over them.",
  estimatedSeconds: 30,
  hasAudio: true,
  tool: true,
  graph,
  params,

  finalizeCases: [
    {
      name: "three scenes",
      values: {
        song: "song.mp3",
        song_seconds: 14.8,
        scenes: JSON.stringify([
          { file: "video/a.mp4 [output]", seconds: 4.5 },
          { file: "video/b.mp4 [output]", seconds: 6.1 },
          { file: "video/c.mp4 [output]", seconds: 4.2 },
        ]),
      },
    },
    {
      name: "more scenes than one join takes",
      values: {
        song: "song.mp3",
        song_seconds: 1010,
        scenes: JSON.stringify(
          Array.from({ length: 202 }, (_, index) => ({ file: `video/s${index}.mp4 [output]`, seconds: 5 })),
        ),
      },
    },
    {
      name: "a scene list that climbs out of the output folder",
      values: {
        song: "song.mp3",
        scenes: JSON.stringify([{ file: "../secrets.mp4 [output]", seconds: 4 }]),
      },
      rejects: "not a clip this can join",
    },
  ],

  finalize(graph, values) {
    const clips: [string, number][] = [];
    parseScenes(values.scenes).forEach((scene, index) => {
      const load = `load_${index}`;
      const trim = `trim_${index}`;
      graph[load] = {
        class_type: "LoadVideo",
        inputs: { file: scene.file },
        _meta: { title: `Load Video (scene ${index + 1})` },
      };
      graph[trim] = {
        class_type: "VideoTrim",
        inputs: {
          video: [load, 0],
          // The widget's own shape: a window from the first frame.
          trim: { trim: { start_time: 0, duration: scene.seconds } },
          strict_duration: false,
        },
        _meta: { title: `Video Trim (scene ${index + 1})` },
      };
      clips.push([trim, 0]);
    });
    wireJoin(graph, clips);
  },
};

/**
 * Joins a multi-scene video's scenes with the sound each one was made with.
 *
 * No song: `ConcatenateVideo` without `complete_audio` carries every scene's
 * own track, decoded and written again as one. And no trims — a multi-scene
 * scene is run at a length H3 makes exactly (see `storySeconds`), so the clip
 * is the scene. A trim is a re-encode of each scene's sound on its own,
 * which is the step FFmpeg's AAC encoder once aborted in (see `silentCopy`
 * in the music video's hook), so leaving it out is one fewer.
 *
 * Every scene has to have sound for this — the node refuses a mix of clips
 * with and without — and every H3 run has.
 *
 * A scene with a `sound` clip carries that clip's sound instead: the Upscale
 * workflow's copies of a long swap's segments come back with each one's sound
 * 4–19 ms short of its picture (VHS drops the last part-block of AAC), and
 * laid end to end those gaps were a stutter at every join and a soundtrack
 * 0.6 s ahead of the picture by the end of a 52-segment swap (2026-11-17). So
 * the upscaled join takes each segment's sound from the take it upscaled,
 * whose sound is its picture's length. `LoadAudio` keeps a file's AAC end
 * padding, about 17 ms that FFmpeg would strip, so each is trimmed to the
 * scene's length before they are joined into one track for `complete_audio`.
 * It is all scenes or none: a track only part made of `sound` clips would
 * have nothing to fill the rest.
 *
 * A `soundtrack` clip goes further: every scene is a stretch of it, from its
 * `from` for its `seconds`, and the sound is cut out of one read of it. A long
 * Character swap has one — every segment is cut from the same clip by time and
 * keeps that clip's sound — so its join reads the clip's own sound rather
 * than 52 segments' copies of it, each re-encoded on the way. Those wandered
 * 20 ms either side of the clip's even before any upscale (2026-11-17). By
 * stretch and not one track from the top, because a segment ending at a
 * shot's exact cut can come out a frame short of its plan, and its picture
 * skips that frame of the clip: the sound skips with it and stays in sync.
 * So `seconds` has to be each clip's real length here. Unset, the loader is
 * taken out.
 */
const SOUNDTRACK_NODE = "soundtrack";

const ownSoundGraph: ComfyGraph = {
  [LIST_NODE]: graph[LIST_NODE],
  [SOUNDTRACK_NODE]: {
    class_type: "LoadAudio",
    inputs: { audio: "" },
    _meta: { title: "Load Audio (the clip under every scene)" },
  },
  [JOIN_NODE]: {
    class_type: "ConcatenateVideo",
    inputs: { codec: "auto" },
    _meta: { title: "Concatenate Video" },
  },
  save: {
    class_type: "SaveVideo",
    inputs: {
      video: [JOIN_NODE, 0],
      filename_prefix: "video/multi_scene",
      format: "auto",
      codec: "auto",
    },
    _meta: { title: "Save Video" },
  },
};

export const multiSceneStitch: WorkflowDef = {
  id: "multi-scene-stitch",
  name: "Multi-scene video",
  description: "Joins a multi-scene video's scenes, each with its own sound.",
  estimatedSeconds: 30,
  hasAudio: true,
  tool: true,
  graph: ownSoundGraph,
  params: [
    params[0],
    {
      id: "soundtrack",
      label: "Soundtrack",
      type: "written",
      default: "",
      maxLength: 300,
      group: "Scenes",
      targets: [{ node: SOUNDTRACK_NODE, input: "audio" }],
    },
  ],

  finalizeCases: [
    {
      name: "three scenes",
      values: {
        scenes: JSON.stringify([
          { file: "video/a.mp4 [output]", seconds: 8.04 },
          { file: "video/b.mp4 [output]", seconds: 5.04 },
          { file: "video/c-audio.mp4 [output]", seconds: 12.04 },
        ]),
      },
    },
    {
      name: "one scene",
      values: { scenes: JSON.stringify([{ file: "video/a-audio.mp4 [output]", seconds: 12.04 }]) },
    },
    {
      name: "upscaled scenes with their takes' sound",
      values: {
        scenes: JSON.stringify([
          { file: "video/a-audio.mp4 [output]", seconds: 5.125, sound: "video/a.mp4 [output]" },
          { file: "video/b-audio.mp4 [output]", seconds: 4.25, sound: "video/b.mp4 [output]" },
          { file: "video/c-audio.mp4 [output]", seconds: 2.5, sound: "video/c.mp4 [output]" },
        ]),
      },
    },
    {
      name: "one upscaled scene with its take's sound",
      values: {
        scenes: JSON.stringify([
          { file: "video/a-audio.mp4 [output]", seconds: 5.125, sound: "video/a.mp4 [output]" },
        ]),
      },
    },
    {
      name: "a long swap under its clip's own sound",
      values: {
        soundtrack: "Tiktok⧸Reels clip #2 [vDIThTS8DeE].mp4",
        scenes: JSON.stringify([
          { file: "video/a.mp4 [output]", seconds: 5.125, from: 0 },
          { file: "video/b-audio.mp4 [output]", seconds: 4.208, from: 5.125 },
          { file: "video/c-audio.mp4 [output]", seconds: 2.5, from: 9.375 },
        ]),
      },
    },
    {
      name: "a long swap with more segments than one join takes",
      values: {
        soundtrack: "clip.mp4",
        scenes: JSON.stringify(
          Array.from({ length: 150 }, (_, index) => ({
            file: `video/s${index}.mp4 [output]`,
            seconds: 2,
            from: index * 2,
          })),
        ),
      },
    },
    {
      name: "a soundtrack and each scene's own sound at once",
      values: {
        soundtrack: "clip.mp4",
        scenes: JSON.stringify([
          { file: "video/a-audio.mp4 [output]", seconds: 5.125, sound: "video/a.mp4 [output]" },
        ]),
      },
      rejects: "not both",
    },
    {
      name: "a soundtrack with a scene that does not say where it starts",
      values: {
        soundtrack: "clip.mp4",
        scenes: JSON.stringify([
          { file: "video/a.mp4 [output]", seconds: 5.125, from: 0 },
          { file: "video/b.mp4 [output]", seconds: 4.25 },
        ]),
      },
      rejects: "where in the soundtrack",
    },
    {
      name: "a soundtrack that climbs out of the input folder",
      values: {
        soundtrack: "../secrets.mp4",
        scenes: JSON.stringify([{ file: "video/a.mp4 [output]", seconds: 5.125, from: 0 }]),
      },
      rejects: "not a clip this can read",
    },
    {
      name: "only some scenes with another clip's sound",
      values: {
        scenes: JSON.stringify([
          { file: "video/a-audio.mp4 [output]", seconds: 5.125, sound: "video/a.mp4 [output]" },
          { file: "video/b-audio.mp4 [output]", seconds: 4.25 },
        ]),
      },
      rejects: "every scene takes its sound",
    },
    {
      name: "a sound clip that climbs out of the output folder",
      values: {
        scenes: JSON.stringify([
          { file: "video/a-audio.mp4 [output]", seconds: 5.125, sound: "../secrets.mp4 [output]" },
        ]),
      },
      rejects: "not a clip this can join",
    },
    {
      name: "a scene list that climbs out of the output folder",
      values: { scenes: JSON.stringify([{ file: "../secrets.mp4 [output]", seconds: 4 }]) },
      rejects: "not a clip this can join",
    },
  ],

  finalize(graph, values) {
    const scenes = parseScenes(values.scenes);
    const withSound = scenes.filter((scene) => scene.sound !== undefined).length;
    if (withSound > 0 && withSound < scenes.length) {
      throw new ParamError("Either every scene takes its sound from another clip, or none does.", "scenes");
    }
    const track = String(values.soundtrack ?? "");
    if (!track) {
      delete graph[SOUNDTRACK_NODE];
    } else {
      if (!isSourceName(track)) {
        throw new ParamError("The soundtrack is not a clip this can read.", "soundtrack");
      }
      if (withSound > 0) {
        throw new ParamError("A join has one soundtrack or each scene's own sound, not both.", "soundtrack");
      }
      if (scenes.some((scene) => scene.from === undefined)) {
        throw new ParamError("Every scene has to say where in the soundtrack it starts.", "scenes");
      }
    }
    let soundtrack: [string, number] | null = null;
    const clips: [string, number][] = [];
    scenes.forEach((scene, index) => {
      const load = `load_${index}`;
      graph[load] = {
        class_type: "LoadVideo",
        inputs: { file: scene.file },
        _meta: { title: `Load Video (scene ${index + 1})` },
      };
      clips.push([load, 0]);

      // The scene's sound: its stretch of the soundtrack, or its own clip's
      // from the top, trimmed to the scene either way.
      let source: [string, number];
      let start = 0;
      if (track) {
        source = [SOUNDTRACK_NODE, 0];
        start = scene.from ?? 0;
      } else if (scene.sound !== undefined) {
        const sound = `sound_${index}`;
        graph[sound] = {
          class_type: "LoadAudio",
          inputs: { audio: scene.sound },
          _meta: { title: `Load Audio (scene ${index + 1})` },
        };
        source = [sound, 0];
      } else {
        return;
      }
      const trim = `sound_trim_${index}`;
      graph[trim] = {
        class_type: "TrimAudioDuration",
        inputs: { audio: source, start_index: start, duration: scene.seconds },
        _meta: { title: `Trim Audio Duration (scene ${index + 1})` },
      };
      if (soundtrack === null) {
        soundtrack = [trim, 0];
        return;
      }
      const joined = `sound_join_${index}`;
      graph[joined] = {
        class_type: "AudioConcat",
        inputs: { audio1: soundtrack, audio2: [trim, 0], direction: "after" },
        _meta: { title: `Audio Concat (to scene ${index + 1})` },
      };
      soundtrack = [joined, 0];
    });
    wireJoin(graph, clips);
    if (soundtrack) graph[JOIN_NODE].inputs.complete_audio = soundtrack;
  },
};

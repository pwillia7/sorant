# The workflows

[← Back to the README](../README.md)

What each workflow does, what it reads, and the hand-offs between them. Start
with the overview table, then jump to the one you are using.

## Contents

- [Overview](#overview)
- [Image to video](#image-to-video)
- [Remix](#remix)
- [Extend](#extend)
- [Text to Image](#text-to-image)
- [Music video](#music-video)
- [Multi-scene video](#multi-scene-video)
- [Create video, from a finished track](#create-video-from-a-finished-track)
- [A voice, as a reference of its own](#a-voice-as-a-reference-of-its-own)
- [One voice, one speaker](#one-voice-one-speaker)
- [A clip as a reference](#a-clip-as-a-reference)
- [How the hand-offs are wired](#how-the-hand-offs-are-wired)
- [Audio](#audio)
- [Music](#music)
  - [Length is a target, and the sampler decides the rest](#length-is-a-target-and-the-sampler-decides-the-rest)
  - [The two guidance scales](#the-two-guidance-scales)
- [Upscale](#upscale)
  - [SeedVR2](#seedvr2)
- [Edit image](#edit-image)

## Overview

Six target **MiniMax H3** and produce a video with a generated audio track;
Text to Image runs the same model and stops at a still. They share sampling,
timing and encoding controls via `minimax-common.ts`.

| Workflow | Output size comes from |
| --- | --- |
| `minimax-h3` — text to video | Aspect ratio + megapixels (`ResolutionSelector`) |
| `minimax-h3-image` — text to image | Aspect ratio + megapixels, 2.5 MP by default and up to 4 |
| `minimax-h3-i2v` — image to video | The uploaded image, rescaled by `ImageScaleToTotalPixels` |
| `minimax-h3-ref` — reference to video | Aspect ratio + megapixels (`ResolutionSelector`) |
| `minimax-h3-ref2v` — remix | The source clip's frames, measured by `GetImageSizeAndCount` — length included |
| `minimax-h3-extend` — extend | The source clip's **last frame**, measured by `GetImageSize` (whichever seam the run takes) |
| `music-video` — music video | Aspect ratio, applied to every scene; each scene is a `minimax-h3-ref` run |
| `multi-scene` — multi-scene video | Aspect ratio, applied to every scene; each scene is a `minimax-h3-ref` run, or `minimax-h3` when it has no pictures and no voices |
| `upscale` — upscale | The **Output size** control, applied to the clip's short side |
| `image-edit` — the Edit button | The picture's own shape, at 1 MP |

`minimax-music3` is a different model family and the only one that
produces no picture at all — see [Music](#music). It shares the director
machinery and nothing else, and none of the switches below apply to it.


## Image to video

`LoadImage` takes a *filename*, not image data, so the file has to exist in
ComfyUI's input directory before the prompt is queued. `POST /api/upload`
relays a browser upload to ComfyUI's `/upload/image` and returns the reference
that `LoadImage` needs. The upload happens as soon as a file is chosen, so a
rejected image surfaces immediately rather than failing a generation you have
already committed to.

Two constraints govern the upload path:

- **`api()` must not set a Content-Type on FormData.** The browser generates
  `multipart/form-data; boundary=...` itself, and overwriting that header strips
  the boundary, so the server parses an empty form and reports "No image was
  included in the upload." This bit once — the shared client helper was setting
  `application/json` on every request that had a body.
- **Vercel caps function request bodies at 4.5 MB** (`413
  FUNCTION_PAYLOAD_TOO_LARGE`), enforced before the handler runs. The client
  downscales anything over 4 MB in a canvas and re-encodes as JPEG rather than
  letting it fail. Nothing is lost: `ImageScaleToTotalPixels` rescales to about
  1 MP server-side anyway, and alpha is meaningless for a video's first frame.

One thing about that graph is easy to get wrong: **`image_megapixels` is the
real resolution control**, because width and height come from `GetImageSize`
reading the rescaled upload rather than from any size picker. There is no
`ResolutionSelector` in this graph at all — an earlier export carried an
orphaned one, and the current export drops it.

## Remix

`minimax-h3-ref2v` takes a clip and rebuilds it. Everything the graph needs is
derived from that one input:

- `VHS_LoadVideo` (154) reads it at 24 fps. Its frames and its soundtrack become
  `ref_videos.ref_video_0` and `ref_video_audios.ref_video_audio_0`, and that
  pair is the **only** visual input the sampler gets.
- `VHS_SelectEveryNthImage` (155) takes every nth frame for the prompt director
  and nowhere else — so the rewrite can see the clip it is editing instead of
  working blind from a filename — at a stride `ComfyMathExpression` (157) works
  out from the frame count the loader reports.
- `GetImageSizeAndCount` (163) measures the clip's own frames — not the
  five-frame sample — and supplies all three dimensions of the output: width,
  height, and length as a frame count. A remix comes back the same shape and
  the same length as what went in, so this graph has neither a
  `ResolutionSelector` nor a duration node, and no frame-count expression to
  derive one from.

An earlier version also wired those five frames into `ref_images.ref_image_0..4`
on the reference node, handing the model the same footage twice — once as a
video reference and again as five stills to reconcile with it. That graph is
kept, unregistered, at `archive/minimax-h3-remix-frame-refs.ts`; it still
compiles, so a rename in `minimax-common.ts` surfaces there rather than letting
it rot.

**The clip is the only input the form offers.** There are no image, audio, size
or duration controls, and that is the point rather than an omission: every one
of those is a consequence of the clip, so a picker would imply a choice that
does not exist. What stays editable is what the clip cannot decide: the prompt
and the sampling settings.

**Words in the clip** is the one addition, and it is not a second input to the
graph — it writes nothing the clip does not already fill. The clip's audio is a
recording H3 is being asked to work over, and nothing on this side can hear it:
the director is shown five frames and no sound, and the model regenerates a
soundtrack from a description that never contained the words. `REMIX_DIRECTOR`
handles that honestly, by telling the director to carry the speech over *without
quoting it* and to write `[unclear]` rather than guess — which preserves nothing
at the point where the soundtrack is re-rendered. Typing the words out is what
removes the premise. They go into the prompt and into the director's brief
through `wordsBlocks`, exactly as Reference to Video's attached track does, and
the block for a clip carries an extra paragraph naming the rule it lifts: the
words may now be quoted, `[unclear]` no longer applies to anything typed, and
speaker IDs still follow this director's own rule — a person producing the voice
gets one, a lyric inside reused music is `<Audio 1>` being audible and gets
none.

A clip can arrive two ways — the Remix button, or an upload. Uploads are held
to **768×1344, 20 seconds and 4 MB** (`video-upload.tsx`). The size and length
limits matter more here than the file-size one: the remix is generated at the
source's own dimensions and for as many frames as it has, so an oversized clip
does not merely upload slowly, it asks the model for a canvas it was never
built for. Both are checked in the browser before the upload starts, because
reading them needs a decoder and the browser already has one — and because
there is no point sending a file that was never going to work.

**Remix** on a finished generation is the quickest way in. It selects this
workflow, loads the clip, carries the prompt it was made with across, and
stops — nothing is submitted, because the point is to edit before running.
Which settings travel is the `carry` list on the workflow's own `clipTarget`;
the seed deliberately does not, since reusing it would pin the new take to the
old one's noise.

The copy is the part that needs a route of its own. ComfyUI writes what a
workflow produces to its **output** directory and only lets loader nodes read
from its **input** directory, and nothing in its HTTP API moves a file between
the two. So `POST /api/remix` fetches the clip through `/view` and posts it
back to `/upload/image` — which is the upload endpoint for any media, there is
no `/upload/video`. That runs server-side rather than round-tripping through
the browser: a generated clip is comfortably past the 4.5 MB body cap, and the
bytes would otherwise cross the user's connection twice for no reason. Extend
uses the same route: the two differ in what they do with a clip, not in how it
reaches ComfyUI's input directory.

## Extend

`minimax-h3-extend` keeps a clip running past where it stopped. Structurally it
is the image-to-video graph with the end of the clip standing in for an upload,
plus a join on the way out. `VHS_LoadVideo` (126) reads the clip at 24 fps,
`GetImageSize` (120) measures its last frame for the output size, and the
prompt director is shown that frame. What the model itself starts from — the
seam — is built one of two ways, chosen per run in `finalize`:

- **From the latents**, when the clip was generated by this app. Every H3 graph
  that makes a video also saves the last 7 video tokens (22 frames, 0.92 s) and
  the matching audio latents of its sampler output, about 2 MB, through
  ComfyUI's `SaveLatent` (`latent-tail.ts`). The Extend button copies both
  files beside the clip as `source_tail`. `LoadLatent` (141, 142) reads them,
  145 pads the video to the new segment's length under a denoise mask that
  keeps those tokens fixed, and 148 freezes the audio the same way. The new
  segment *starts with* the end of the old one, sound included, and is sampled
  onward from it, with no decode and re-encode in between. 151 and 152 then
  drop the repeated 22 frames before the join.
- **From the last frame**, for anything else: an upload, a clip from before
  the tails existed, an upscale. `RandomImageFromBatch` (128) takes the last
  frame (`start_index: -1`, `num_frames: 1`) and `MiniMaxH3ImageToVideo` gets
  it as `first_frame`. That one frame is the whole bridge; nothing else about
  the source reaches the model.

A tail counts only when it is named after the clip in the source slot — an
upload over a generated clip drops back to the last frame rather than gluing
another clip's ending on.

The difference shows. Measured on the box over three passes each (2026-10-19),
the last-frame seam drifted — contrast climbed 79 → 91, colour cast red, and
every join held a frame — because each pass goes through a VAE decode, an MP4
encode, a decode and a VAE encode before the model sees it again. The latent
seam kept the colour flat, joined without a jump, and carried the voice across.
Compare continuation quality between the two only with that in mind.

The rest of the graph is the same either way:

- The `105:*` nodes are the same sampler stack and the same duration →
  frame-count expression as the other generating graphs.
- `BatchImagesNode` (131) concatenates the source frames with the generated
  ones, `AudioConcatenate` (135) does the same to the two audio tracks, and
  137/138 save the result. **The output is the whole video**, not the segment
  on its own — which is what lets an extension be extended again with no
  reassembly by hand, and from the latents each time, since the result saves a
  tail of its own.

Two consequences worth knowing before changing anything:

- **Duration times the addition, not the result.** Ask for 5 seconds on a
  10-second clip and 15 seconds come back. The control is relabelled *Added
  time* for exactly this reason. Sampling cost stays flat as the clip grows,
  since only the new segment is ever generated; the decode and re-encode of the
  join do not.
- **The prompt does not carry over from the source**, which is the one place
  Extend deliberately differs from Remix. The text that made the source
  describes the source, and `EXTEND_DIRECTOR` reads its input as what happens
  next — handing it the old prompt would ask the clip to do again what it just
  did. That is why `carry` lives on each workflow's `clipTarget` rather than
  being one list in the UI. What it gets instead is the **story so far**: the
  prompt that made the source and every Extend line since, filled in by the
  hand-off and handed to the director as background it must not replay. Without
  it the director knows the clip only from its last frame and re-describes the
  people from that alone, drifting a little further each pass. Like the tail,
  it only applies to the clip it was written about.

## Text to Image

`minimax-h3-image` is the Text to Video graph made to stop at a still. H3 has
no image mode, so a still is the **first frame of the shortest clip it makes**
— five frames, two latents. One latent would be a true single frame, but H3's
VAE decodes one on its own dark and banded on builds before ComfyUI 0.40, and
the core latent nodes still floor the length at five frames; two decode
cleanly on any version for a second or two more.

The sampling is its own, not Text to Video's. Turbo at full strength gives a
still an oversaturated, crunchy look, so it runs the Turbo LoRA at **0.38,
`er_sde`, 20 steps** — about 50 seconds at 2.5 MP on a 3090. A still also
wants more pixels than a frame of video: past H3's ~1 MP video canvas it keeps
gaining detail, so the size control defaults to 2.5 MP and goes to 4. Its director,
`STILL_DIRECTOR`, writes H3's three fields for one static frame with silence
for the sound.

## Music video

`music-video` makes a video for a whole song from one idea and up to four
reference pictures. It is not one long take extended over and over: every
scene is a fresh **Reference to Video** run with the song locked in under it,
and nothing carries between scenes except the pictures, so there is nothing to
drift. What holds them together is the plan.

1. **Scenes.** The browser decodes the song, finds its beats and loudness
   (`src/lib/music-video/beats.ts`), and cuts it into scenes of 4–9 seconds on
   the strongest beats near each target length (`scenes.ts`).
2. **The outline.** The graph runs once with `MUSIC_VIDEO_PLANNER`: shown the
   pictures, each scene's place in the song and its loudness, and the lyrics
   if there are any, it returns a JSON outline — a concept, then per scene the
   part of the song, whether anyone sings, the place and what happens. A
   second director in the same run describes the cast **from the pictures
   alone**, so every scene
   gets the same description of who is in it.
3. **The shots.** `SHOT_WRITER` then writes each scene's shot in a call of its
   own, shown the whole outline. One reply for every shot got the scene count
   wrong on four plans in six and came back as broken JSON; a shot written
   alone is plain text with nothing to parse. Each scene's outline line can be
   edited in the panel and just that shot rewritten.
4. **The scenes** render as Reference to Video runs, the song under each one.
   A scene renders from the video's pictures unless it is given its own under
   **Pictures** — someone who appears only there, a place, a prop. Its own
   start as a copy of the video's; while they still start with the video's,
   in the same slots and keeping the same things, the cast description is
   handed to it as to every scene, and once one is swapped or dropped it is
   left out, since it names the pictures by slot (`keepsVideoLook` in
   `project.ts`). The shot writer does not see a scene's own pictures, so a new
   one is named in the shot by number.
   Redo keeps every take, and the take used is picked under the scene. Scenes
   whose runs were lost track of — a ComfyUI restart, a dropped connection —
   can be found again on the machine by their file order and length
   (`recover.ts`).
5. **The join.** `music-video-stitch` trims each scene to its window, joins the
   encoded clips without decoding them (`ConcatenateVideo`), and lays one read
   of the song over the whole thing, so the audio has no seams.

A music video then upscales scene by scene with RTX Video — see
[Upscale](#upscale).

## Multi-scene video

`multi-scene` is the music video without the song: one idea told in several
scenes, each with the sound H3 makes for it — a short film, a sketch, a
story. Both are built on `planned-video.ts`, which holds the plan graph, the
pictures, the cast describer and `finalize`; each brings its own planner,
shot writer and controls.

What changes without a song:

1. **The scene count is the user's, the lengths are the planner's.** There
   are no beats to cut on, so **Scenes** sets how many, and the planner gives
   each a length of 4–15 seconds from what happens in it and how much is said
   (about two and a half words a second). Each length is snapped up to one H3
   makes exactly (`storySeconds` in `scenes.ts`), so the clip is the scene and
   nothing is trimmed off it. Every scene's length can be changed in the panel.
2. **Dialogue.** The outline has a `lines` field per scene — `Name: words`,
   a turn per line — which the shot writer quotes word for word. **Dialogue**
   off tells the planner nobody speaks, and every scene with no lines is sent
   with "Nobody speaks in this scene", since a scene director left free writes
   some.
3. **Voices.** Up to two recordings, each with whose voice it is, go under
   every scene, like the pictures — they are what makes one person sound the
   same from scene to scene. A scene can have its own voices (someone who
   speaks only there) or none (a scene its speakers are not in). With two,
   the one whose speaker has the first line is wired last, read off the
   scene's lines and overridable as **Speaks first**; see
   [One voice, one speaker](#one-voice-one-speaker).
4. **Bare scenes.** Reference to Video refuses a run with nothing to build
   from, so a scene with no pictures and no voices is a Text to Video run
   (`scenes.bare`). `check:workflows` holds the two graphs' shared controls
   to the same kinds.
5. **The join keeps each scene's sound.** `multi-scene-stitch` concatenates
   the clips without `complete_audio`, so ComfyUI carries each one's track,
   and without trims. Its audio is still decoded and written again as AAC —
   the same encoder the music video's join uses for the song — so the one
   crash seen there ([music video's join](#music-video)) is not ruled out
   here. The upscaled join reads each upscale's file with sound rather than
   the silent copy.

Each kind keeps its own project in the browser, so a music video and a
multi-scene video can be in progress at once.

## Create video, from a finished track

The third hand-off, and the only one that is not about a clip.
`minimax-h3-ref` declares it, so pressing **Create video** on a finished song
selects Reference to Video and loads the track into its `Reference track` slot.
The wiring on the graph side is one `LoadAudio` (155) feeding
`ref_audios.ref_audio_0` on the reference node — a variadic input on the same
node the pictures use, so it obeys the same rule: unused means *removed*, along
with its loader, rather than left blank.

Note which workflow that is: `minimax-h3-ref` is **Reference to Video**, the
one with the image slots. `minimax-h3-ref2v` is **Remix**, which takes a clip
and has never had image references — its `MiniMaxH3ReferenceToVideo` gets
`ref_videos.*` and `ref_video_audios.*` from the source and no `ref_images.*` at
all. Neither of those facts changed here.

The pictures are untouched by it. Reference to Video still offers its **four
reference image slots**, each with its own preservation-facet select, each
revealed by the one before it, all wired to `ref_images.ref_image_0…3` exactly
as before. A run can have four pictures and a track, or a track and nothing
else, or the pictures alone as it always could — which is why the first image
slot is no longer `required`. "At least one of two controls" is not something
`required` can say, so the check moved to `finalize`, where both answers are
visible, and throws the same `ParamError` a rejected value does. A run with no
pictures at all also drops `BatchImagesNode` and the director's `images` input:
an empty batch is not an empty list of images, it is a node that cannot produce
the IMAGE its consumer asked for. `referenceFacets` says so in words as well,
because `REFERENCE_DIRECTOR` otherwise writes the `<Picture 1>` citations its
format calls for at a model that was given none.

**A track pins the run to four steps, and four steps loads different weights.**
The pair used to fail: a track with pictures came back from ComfyUI as
`RuntimeError: The size of tensor a (3) must match the size of tensor b (2) at
non-singleton dimension 0`, and nothing documented why it should — the node's
own docs allow up to 9 images, 3 videos and 3 standalone audios with no
exclusion stated, and reading `nodes_minimax_h3.py`, `ldm/minimax/model.py` and
`text_encoders/minimax.py` turns up no path that treats the combination
differently. It was the quantised weights. At four steps this graph loads
`minimax_h3_ref2va_bf16` and `qwen3vl_32b_minimax_h3_bf16` in place of
`minimax_h3_ref2va_pruned_int8_convrot` and `qwen3vl_32b_minimax_h3_nvfp4_awq`,
and that pair takes references of both kinds together.

Two declarations do it, both in `minimax-h3-ref.ts`. `FOUR_STEP_MODELS` hangs
off the workflow's `stepSampler` — the same trigger that already swaps in the
pack's four-step sampler, so there is one form of this graph at four steps
rather than two rules that could disagree, and `check:nodes` asks ComfyUI about
the bf16 files because `stepSamplerGraph` produces them. `TRACK_PINS_STEPS` is a
`pinnedBy` on the steps control: while a track is loaded the control shows 4,
takes no input, and submits 4 whatever was stored — `applyParams` overwrites the
submitted value after coercion, so a stored 12 from an earlier run cannot sail
past it. Removing the track hands the control back with that number still in it.

Leave **Turbo** on for those runs. Four steps swaps the sampler but not the
distilled LoRA, which is a switch of its own, and four steps without it is not a
usable take — see the note under the control. **Spectrum** goes the other way:
this graph refuses it at four steps, so a run with a track never has the
forecaster in it. That is `suppresses` on the same `stepSampler`, and the switch
shows as off with the reason under it rather than being silently dropped.

Three further things are deliberately *not* true of it:

- **It does not set the length.** The video is as long as the Duration control
  says, capped at 20 seconds. A four-minute song is a reference for those
  seconds — and only those seconds actually go: a `TrimAudioDuration` at node
  167 sits between the loader and the reference node, and **How much of the
  track** decides what it is given. The default is the video's own length, the
  *snapped* one rather than the number on the slider, so the reference matches
  what comes back rather than what was asked for. *A set length* reveals a
  seconds control; *all of it* deletes the trim and wires the loader straight
  through, which is the old behaviour and rarely what anyone wants — MiniMax's
  model card puts a reference track at 2–15 seconds, ComfyUI's standalone
  `ref_audios` path truncates nothing, and a three-minute track is thousands of
  latent frames of packed sequence for a five-second video. **Start at** picks where
  those seconds come from, so a song's chorus is reachable and not just its
  intro. Every one of those controls writes its node input through one function,
  for the same reason the director's instructions are assembled by one: a target
  write is an assignment, so each contributor has to produce the whole answer.

  The start is only safe because the track gets measured. `TrimAudioDuration`
  clamps a start to the length of the audio and then raises when nothing is left
  between start and end, which is the one way to fail it — so `AudioUpload`
  reports the length it already reads off the loaded player, `measures` carries
  it into a `measured` param exactly as a video clip's does, and `finalize`
  rejects an impossible start at submit with the track's real length in the
  message. Rejected rather than clamped: quietly moving to a different part of
  the song is worse than being told, and this is a number someone typed. With no
  measurement — a form submitted before the player has its metadata — the start
  is passed through, which is the risk every run took before the control
  existed.
**What to keep from the clip's sound** decides what the generated audio owes an
attached recording. H3's format carries its own markers for this, separate from
the ones a picture takes — `fully_copy`, `partially_copy`, `reference`,
`weak_reference` — and the director was picking one by judging how sweeping it
thought the request was. The control is the user saying it outright:

The answers are the cells of a grid — what is said, and how it sounds — plus the
music and room tone underneath both:

| Answer | Marker | Words | Voices | Music and room |
| --- | --- | --- | --- | --- |
| Keep it exactly | `fully_copy` | kept | kept | kept |
| Same voices, new words | `partially_copy` | new | kept | kept |
| Same words, new voices | `partially_copy` | kept | new | kept |
| New words and voices | `partially_copy` | new | new | kept |
| Nothing — the whole soundtrack fresh | `weak_reference` | new | new | new |

*Same voices, new words* is the one worth knowing about: it is
[voice referencing](https://www.rundiffusion.com/minimax-h3-prompt-guide), where
the reference guides timbre and delivery while the lines come from the prompt.
*Same words, new voices* is its mirror, and the one case where **Words in the
clip** stops being optional — the director has to write lines it has never
heard, so the transcript is the only copy of them there is.

They name what to take rather than how much of it, which is how MiniMax frames a
reference — there is no documented dial for *degree* of reuse, so offering one
would be inventing a control the model does not have.

Remix defaults to **Keep it exactly**, which is what its director assumed before
the control existed. A reference clip defaults to **New words and voices**:
there the clip is a reference rather than the thing being rebuilt, and switching
its soundtrack on at all is a choice to use it for something — so the room and
any music carry, and the speech does not. The block is written to
*lift* the standing preservation rules rather than sit beside them — REMIX_DIRECTOR
spends a page on holding `<Audio 1>`, and an appendix that merely disagreed
would be a director told two things.

**Words in the clip** follows that grid. It exists so the model does not sing its
own words over speech it cannot hear, which is a problem only while those words
are being reused — so on the three answers that write new ones the transcript is
withheld from the prompt as well as from the brief, rather than the prompt
carrying the very lines the rest of it says to replace. Which answers those are
is derived from the list rather than written down twice, so a sixth cannot be
added without deciding it.

- **It is not the output soundtrack.** H3 generates its own audio; the track
  conditions it. `referenceTrack` in `minimax-common.ts` tells the director so,
  because left alone it writes a `non_diegetic_music` section inventing a score
  — which then asks the model for a second piece of music over the one it was
  handed. The director never hears the track: the rewrite stage is shown images
  and nothing else.
- **Nothing here can hear it, so the words have to be typed.** That is
  **Words in the track**, revealed by the track and empty by default. Without it
  the model is handed a recording and asked to generate audio over it with no
  idea what is being sung, so it writes its own words — which is the usual
  reason a vocal comes back not matching the song it was built around.

  It writes *the prompt*, not only the director's brief, which is the whole
  point of where it is wired. The rewrite is optional — **Send my prompt as
  written** deletes the rewrite node outright — so anything that reached H3 only
  through the director would silently vanish for exactly the people who chose to
  write the format by hand. So `promptTarget` in `minimax-common.ts` is the
  prompt's equivalent of `directorTarget`: several controls write the same node
  input, and each of them assembles the whole string, because a target write is
  an assignment and the last one to run would otherwise win with half an answer.
  The words land under a `THE WORDS IN THE REFERENCE TRACK` heading after
  whatever was typed, verbatim. They are not wrapped in `<d>` tags here — the
  grammar requires the language tag to agree with the text, and this app has not
  been told which language it is looking at.

  The director gets a second block, `referenceLyrics`, saying what that heading
  is and what to do under it: copy the words character for character into
  `detailed_description` inside `<d>` tags with a language tag that matches, in
  order, only as many as fit the video's length, never translated or tidied or
  extended. Bracketed section tags are named as structure rather than words, so
  a lyric sheet straight out of the music workflow goes in as it stands without
  anyone singing `[Chorus]`. Whoever performs them gets a speaker ID; with
  nobody on screen performing, they are written as an off-screen vocal rather
  than dropped.

  With no track attached the block is not written at all, however much is in the
  box — a lyric sheet for a song this run is not being given is words the model
  would perform over silence.
- **Nothing is carried across.** The music workflow shares two param ids with
  this one and means something different by both: its `prompt` describes a
  record rather than a scene, and its `duration` counts minutes where this one
  counts seconds. A carried value is written into the destination's form
  *unclamped*, so that second one would arrive out of range and be rejected at
  submit.

  The lyrics are not carried either, tempting as it looks now that both
  workflows have a box for words. With **Write the lyrics for me** on, the music
  run's `lyrics` value is whatever was sitting in the hidden box while a second
  director wrote the words that were actually sung — `finalize` rewires the node
  to the lyricist, so what was performed never passes through that param at all.
  Carrying it would paste a lyric sheet the track does not sing, confidently,
  into the one field whose whole value is being exact.

Uploading a track by hand works too, and is capped at 4 MB like any other
upload — which a few minutes of mp3 will exceed. The button has no such limit,
because it is the same server-side copy Remix and Extend make.

## A voice, as a reference of its own

**Voice reference** is the second standalone audio slot, and it exists because
the first one is a score. The two take the same kind of file and are for
opposite things: a track plays under the scene and nobody on screen produces it;
a voice belongs to a person in the picture, gets a speaker ID, and never goes
near `non_diegetic_music`. Attach a face and a voice and the person in the
picture speaks in the voice from the file — MiniMax's own
[voice referencing](https://www.rundiffusion.com/minimax-h3-prompt-guide), which
this app had the vocabulary for and no way to reach.

**Two slots rather than one control with a purpose select**, because the node
takes both at once. `ref_audios` is variadic to three — `/object_info` says so —
and numbers what it is given in wiring order, so a run can carry a score *and* a
voice and the director can be told which `<Audio N>` is which. One control read
two ways would have been a control the director could only guess at.

Which makes the numbering load-bearing, and it is now computed in one place.
`audioLabels` in `minimax-common.ts` takes what this run carries and returns the
label for each: a clip's soundtrack takes `<Audio 1>` and pushes both standalone
ones down, then the track, then the voice. Three appendices read it —
`referenceVideo`, `referenceTrack` and the new `referenceVoice` — and they have
to agree, because a director told the voice is `<Audio 2>` while the model was
handed it as `<Audio 1>` writes a prompt about a reference that is not there,
and nothing downstream can see the disagreement.

`finalize` is the other half of that. The two standalone inputs are a *list*,
under the same rule `leadingReferences` enforces for the pictures: a voice with
no track has to ship as `ref_audio_0`, because left in slot 1 with a hole in
front of it what the model is told is that it has two references and the first
is missing. So the list is rebuilt from scratch on every run rather than patched
— and `finalizeCases` carries the pair that proves it, a voice alone and a voice
beside a track, since those differ by exactly the renumbering.

Three further things about it:

- **What to keep from the voice** is the same five-answer grid the clip's
  soundtrack uses, defaulting to *Same voices, new words* — the answer this slot
  exists to make reachable. The recording supplies the timbre, the accent and
  the pacing; the lines come from the prompt. **Words in the voice reference**
  is revealed only on the two answers that reuse what was said, derived from the
  grid rather than listed, exactly as Remix's is.
- **The trim is a fixed window, not the video's length.** That is the one thing
  about a score that does not transfer. A track is cut to the length of the
  video it plays under because matching the two is the point; how long the video
  runs says nothing about how much recording it takes to establish how somebody
  sounds. Ten seconds by default, inside MiniMax's documented 2–15s, with
  **Start at** to move past a silent or noisy opening — and the same
  measure-and-reject safety the track's start has, since it is the same
  `TrimAudioDuration` failing the same way.
- **A voice pins the steps to four like everything else that is not a still**,
  and four steps is now *refused* without Turbo rather than run. The pin swapped
  the sampler and the weights but never the distilled LoRA, which is a mode
  rather than a param — so turning Turbo off and attaching a reference produced
  the one combination this graph has always described as not a usable take, and
  it finished, took the time, and came back wrong. `ParamPin.requiresTurbo`
  carries the rule now; `applyParams` throws it as an ordinary `ParamError`
  against the steps control, where the pin's own note already sits.

`REFERENCE_DIRECTOR` gained the audio half of H3's format along with it, which
it had never had. `subject_definitions` described only "reusable visible
content" and `retention_analysis` listed only the four *visual* markers, so an
attached track was a labelled conditioning block the prompt never once cited —
zero occurrences of `<Audio 1>` in the assembled system prompt, against a page
of careful `<Picture N>` citation. Both sections now name `<Audio N>` and the
audio markers (`fully_copy`, `partially_copy`, `reference`, `weak_reference`),
lifted from `REMIX_DIRECTOR`, which had them all along.

## One voice, one speaker

A voice reference used to reach every speaker in a scene. Attach a face and a
voice, write a two-person argument, and both people came back speaking in the
recording — however firmly the prompt said otherwise. Part of that is H3: the
same leak is reported upstream for plain text voice descriptions
([Comfy-Org/ComfyUI#15454](https://github.com/Comfy-Org/ComfyUI/issues/15454)).
Part of it was the director, which was telling the model to do it:

- The default answer on the keep grid said to "say that the voice heard in the
  reference is what speaks" the lines — all of them, from a block that outranks
  everything above it.
- It marked the voice `partially_copy`, which MiniMax's format defines as
  copying part of the recording. Voice timbre is `reference`. The voice slot now
  overrides the marker through `audioKeep`'s `overrides`; the grid itself is
  unchanged for Remix and the clip, where that answer does copy layers.
- The voice was never bound to a speaker ID. MiniMax's form is
  `<Audio 1> is the voice-timbre reference for <Subject 3> (S1)`, and
  `REFERENCE_DIRECTOR`'s example now follows it.
- Nothing said what to do with anyone else. `referenceVoice` now tells the
  director to cite the label only beside its own speaker — never in a negation
  beside another — to give every other speaker a concrete, contrasting voice
  repeated on each of their lines, and to let the referenced speaker have the
  first line where it can. That last one is a hypothesis: a standalone
  `ref_audio` sits immediately before the generated audio, so the first voice
  after it is the likeliest to inherit it.

Two controls came with it. **Whose voice** says, in the user's words, which
speaker a recording belongs to, so the director is not guessing in a scene with
two candidates. **Second voice** is a third standalone audio — `ref_audios`
takes three, and a track and one voice left one free — always voice
referencing, revealed by the first and counted only beside it, so a stale second
file with the first emptied is dropped rather than shipped as the only voice.

The director changes were not enough on their own. A two-person scene with one
voice reference and a text-voiced second speaker (a well-known actor the model
already knows) still gave both people the recording until the *prompt* changed
too. What cleared it, tested 2026-09-29, with **Whose voice** filled in:

- **The referenced speaker has the first line.** The recording sits directly in
  front of the generated audio, and the first voice after it inherits it.
- **A fixed script of a few short lines**, about twenty words for twelve to
  fifteen seconds. "Improvised", "slightly different phrasing" and "he argues
  that…" invite extra speech nothing binds to a speaker.
- **One close-up per line**, so each voice has its own face and its own stretch
  of audio, and no overlap or interruption — overlap is where voices merge.
- **The other speaker's voice described on each of their lines**, in positive
  terms only, and the recording never mentioned in the prompt at all.

The director already asks for most of this, but it does not reorder or cut a
script the user wrote, so a prompt that fights it wins. The tips say the same.

## A clip as a reference

**Reference clip** takes a video the same way the slots above take a picture,
and for the thing a picture cannot supply: how someone moves. It sits alongside
the pictures rather than instead of them, so a run can carry four stills, a
clip, and a track at once.

This is not Remix. There the clip *is* the video being rebuilt, and the director
is told to preserve its shots, its edit and its camera. Here it is one reference
among several and the target is a new scene — `referenceVideo` in
`minimax-common.ts` spends most of its words on that distinction, because a
director carrying Remix's instinct re-cuts the source instead of building what
was asked for.

The wiring is four nodes. `VHS_LoadVideo` (170) reads the clip, a
`ImageScaleToTotalPixels` (171) scales it to the size of the video being made
and feeds `ref_videos.ref_video_0`, and the loader's own audio output feeds
`ref_video_audios.ref_video_audio_0`. A `VHS_SelectEveryNthImage` (172) strides
that same batch down to about five frames for the director to look at, at a
stride a `ComfyMathExpression` (173) works out from the frame count the loader
reports — the rewrite stage is shown images, so there is no such thing as
showing it a video.

**VHS's loader rather than ComfyUI's own, and that is load-bearing twice.**

`force_rate` resamples the clip to 24 fps, which matters because there is no
resampling anywhere in `nodes_minimax_h3.py`: whatever batch reaches
`ref_videos.ref_video_0` is *interpreted* as 24 fps, and the node's own tooltip
says so. A clip left at its own rate is read at the wrong speed by exactly the
ratio — and the rate is rarely what you would guess. A webcam recording made by
this app measured **16.87 fps**, not 24 and not 30, so read as 24 it would have
run 40% fast.

And VHS can read a file the core loader cannot measure. A browser's
`MediaRecorder` writes a *fragmented* MP4 — a streaming encoder that never goes
back to fill in the header — so its `mvhd` duration is `0` and every sample
table (`stsz`, `stts`, `stco`, `stsc`) has zero entries. ComfyUI's own
`get_frame_count` falls back to decoding and counting but bounds that loop by
the container's duration, so it returns **1**; anything selecting frames from
the VIDEO then hands on one frame, and the reference node rejects the run for
having fewer than five. VHS demuxes the same file and reports its real 14.9
seconds.

**The clip is scaled to the output's own frame size**, which is the difference
between a reference that costs about what a generated frame costs and one that
costs nearly twice as much. The reference node has no opinion about the output:
its canvas is a 768 short edge, and its only restraint is that it will not
upscale. So a 1280×720 recording is conditioned on at 1280×704 — 901,120 pixels
against the 504,832 of a frame at the default 0.5 MP, **1.8× the area, carried
through every sampling step**. `ImageScaleToTotalPixels` takes it to 960×544
instead, on the same **Frame size** control that sets the output, capped at
`REF_MAX_MEGAPIXELS` so the top of that range does not drag a 2 MP reference
through the run. `resolution_steps` is 32 because the reference node rounds its
own canvas to multiples of 32, and landing on one is what stops it resampling a
second time.

**What to keep from the clip** is the control the clip was missing, and its
options are deliberately *not* the ones a reference picture gets. MiniMax's own
guidance is blunt: a reference video pins motion, camera, grade and grain —
[not identity](https://www.atlascloud.ai/blog/tips/minimax-h3-reference-to-video).
Identity comes from a still. So the answers here are **Motion and camera** (the
default, and what a clip is actually for), **Motion only**, **Look only**, and
all three together; there is no "keep the person", because a clip cannot hold
one. Attach a reference image for that and let the clip move it — which is the
combination the guides recommend, and which the director is told to write as a
transfer: *"Transfer the two-step turn from `<Video 1>` to the woman in
`<Picture 1>`, preserving her identity."*

Two things follow from that guidance and are written into the director. `<Video
1>` takes its own line in `subject_definitions` stating what it *provides*
rather than who is in it — *"`<Video 1>` provides the measured walking pace and
the slow half-orbit camera move"* — since it is not a subject. And a clip drags
the source's grade with it whether or not it was asked to: *"you cannot ask one
call for the same look and the opposite light."* Where the user's text calls for
lighting, a palette or an era the clip does not have, the director is told to
put that look firmly in the style line before `[Shot 1]` and not to describe the
clip's own grade at all.

The director is also told, above all of it, that the user's text says what the
target video is, that the clip is a reference brought into it rather than the
thing being edited, and that where the text describes a subject the clip does
not contain, the text wins outright.

**Use the clip's sound** decides whether the soundtrack goes with it, and it is
**off by default**, unlike Remix. That default is
the point rather than a detail: `ref_video_audios` pairs with `ref_videos` by
index and the node fuses the two into a single `video_audio` conditioning block,
which is the same shape Remix hands the model to mean *reproduce this*. A run
whose prompt asks for new dialogue is then arguing with its own conditioning.
`ref_audios` would instead emit a `video` block and an unrelated `audio` one — a clip and a sound
beside it, rather than a clip that sounds like this. **Remix was doing the
second of those and now does the first.** Its labels are unchanged: references
are presented as images, then each video preceded by its own soundtrack, then
standalone audio, numbered 1-based per type, so a lone video is `<Video 1>` and
`<Audio 1>` either way and `REMIX_DIRECTOR` needed no edit.

That numbering does move here, and it is the only place in the app where a track
is not `<Audio 1>`: attach both a clip's soundtrack and a reference track and
the soundtrack takes `<Audio 1>`, pushing the track to `<Audio 2>`.
`referenceVideo` spells that out, since it is the one thing the director could
get backwards.

Three limits worth knowing:

- **A clip pins the steps to 4**, on the same `pinnedBy` as a track — which now
  names both controls, since a pin describes what the run needs rather than what
  one control implies. The reason is the same quantised-weights failure: it was
  a batch-dimension mismatch on a run carrying more than one kind of reference
  block, and a clip is that as much as a track is. Remix, which is nothing but a
  video reference through this same node class, already runs on the bf16 pair.
- **Fifteen seconds reach the model; twenty may be uploaded.** MiniMax documents
  a reference video at 2–15s, and that fifteen is a budget shared with reference
  audio rather than a per-file limit, so `frame_load_cap` stops there and
  nothing past it is decoded. The upload limit is higher on purpose: a longer
  file is truncated rather than refused, since the reference node truncates to
  the generated video's frame count anyway and turning someone away to trim a
  clip by hand buys nothing. The in-app recorder stops at the budget rather than
  the upload limit — footage past it is discarded, and recording it would only
  spend the bitrate allowance on frames nothing will see.
- **The length is not what decides the cost.** A reference
  video is encoded to latent frames that ride through *every* sampling step
  alongside the ones being generated, so its cost is added to the sequence for
  the whole run rather than paid once at the start. But the node truncates a
  reference to the generated video's own frame count (`frames[:frame_count]`),
  so what the model carries is `min(clip, video)` — and the expensive case is
  therefore not a long clip but a clip *as long as the video*, which doubles the
  sequence. That ceiling is 2× and it is reachable at any length: six seconds of
  reference against a five-second video already sits there.

  | video | 3s clip | 6s | 10s | 15s | 20s |
  | --- | --- | --- | --- | --- | --- |
  | 5s | 1.48× | 2.03× | 2.03× | 2.03× | 2.03× |
  | 10s | 1.24× | 1.60× | 1.96× | 2.03× | 2.03× |
  | 20s | 1.12× | 1.31× | 1.49× | 1.74× | 2.00× |

  So a short reference is what keeps a run quick, and a low cap only ever
  punished the long-video runs where a short clip was already cheap. MiniMax
  documents 2–15s; past fifteen is outside what they describe rather than
  outside what the node takes.
- **4 MB and a 768px short edge**, with a 1-second floor because the node
  refuses anything under five frames outright — `minSeconds`/`maxSeconds` on the
  param, checked in the browser before the upload starts. Unlike Remix and
  Extend nothing hands a clip to this slot server-side, so every one of them
  goes through the browser and the 4 MB cap really binds.
- **Nothing past the cap is ever decoded.** `frame_load_cap` is counted in
  frames at the forced rate, so the loader stops there rather than reading a
  long clip and throwing most of it away. Turning the sound off drops the
  reference input but not the loader, which is where the frames come from too.

**Or record one.** The camera button under the clip slot opens `VideoCapture`,
which records with the device's own camera and microphone and hands the file to
the same upload path a clip picked off disk goes through — so it is measured,
size-checked and refused on exactly the same terms. Two things shape it: the
bitrate is budgeted *before* recording from the size cap and the length limit,
because a recording cannot be re-encoded smaller afterwards the way an oversized
photo can; and the recorder stops itself at the limit rather than trusting
anyone to watch a counter. It prefers MP4 where the browser will record one and
falls back to WebM, which Firefox makes non-hypothetical.

## How the hand-offs are wired

All three buttons are registry-driven: a workflow declares
`clipTarget: { action, accepts, sourceParam, carry? }`, and `studio.tsx` finds
the destination for each action rather than naming a workflow id. Registering a
different graph behind Extend moves the button with it, and a build with no
workflow declaring an action simply does not render that button.

`accepts` is what keeps a track out of a `LoadVideo` node: the result view
offers the video actions on a file `REUSABLE_VIDEO` matches and the audio ones
on a file `isAudioOnly` matches, so the question is asked of the file that came
back rather than of the workflow that made it. In the history, whatever a
hand-off produces is threaded under the generation it came from (`derivedFrom`
on the job, `lineageOrder` in `jobs.ts`) — the same indentation serves remixes,
extensions and videos built from a track.

## Audio

Every video graph decodes an audio track into `CreateVideo`, so they set
`hasAudio: true`. The result player does not autoplay audio workflows —
browsers only allow autoplay while muted, which would throw away the
soundtrack the model just spent minutes generating.

Music produces no picture at all, which the app tells from the file that came
back rather than from the workflow that made it — `isAudioOnly` in `jobs.ts`
tests the extension, so history entries still answer correctly after a workflow
has been renamed or removed. An audio result gets an `<audio>` player instead of
a 60vh black rectangle, a small note glyph in the history list, and
`contentTypeFor` learned the audio MIME types so an mp3 is played rather than
downloaded.

An audio entry also gets a **play button on its own row**, because the stage is
where the scrubber is and the stage is at the top of the column — hearing
something made an hour ago otherwise meant scrolling up and then finding your
place again. One `<audio>` element serves the whole list rather than one per
row, which is what makes only one track playable at a time and what keeps a
playing track alive when the day it is in is collapsed. It stops itself if the
row is forgotten, since there would be no pause button left to press. The Generate button reads "Generate music" from the workflow's
`makes` field, and a finished mp3 raises a notification that says so.

## Music

`minimax-music3` runs **MiniMax Music 3**. The graph is ComfyUI's own template
for the model, and the only thing added to it is what the two directors write.

| Control | Writes | |
| --- | --- | --- |
| Describe the music | node 44, via the caption director | One line is enough |
| Write the lyrics for me | — | Adds the lyricist at node 47 |
| What the song is about | the lyricist's system prompt | Only while that switch is on |
| Lyrics | `37:13.lyrics` | Verbatim. Empty means instrumental |
| Plan the sections | node 47, filtered through node 48 | Only while the box is empty and the lyricist off |
| Length | `37:13.max_duration`, plus every director | A target; the cut-off is derived from it |
| Seed | `37:38.seed` | Feeds the AR stage and the sampler both |
| Steps | `37:9.steps` | The diffusion stage only |
| Caption guidance | `37:13.cfg_scale` | Holds structure, and the ending |
| Sampler CFG | `37:9.cfg` | Holds the sound. Leave it |
| Top-k | `37:13.top_k` | The one that actually holds a length |

Nothing here sits behind an Advanced disclosure. The two that used to —
guidance and Top-k — turn out to be what decides whether two runs of the same
prompt come back the same length, which is not expert trivia.

**Two inputs reach the model and they are not alike.** `caption` is the music
description and comes from the director at node 46; `lyrics` is what gets
*performed*, and by default it goes from the form to the model untouched. That
asymmetry is the thing to hold on to — anything that lands in the lyrics field
is sung, including a sentence that was meant as commentary.

**The caption is a structured format, not prose.** Music 3 reads three fixed
headings with fixed field labels under each: `Global Metadata` (BPM, key, genre,
emotional progression, imagery, production profile), `Vocal Details` (timbre,
style, harmony, effects) and `Arrangement` (instrument lifecycles, groove,
textures). `MUSIC_DIRECTOR` in `music3-director.ts` writes exactly that. The
field names are copied from the template files in
[MiniMax's music-caption-rewriter skill](https://github.com/MiniMax-AI/MiniMax-Music3#prompt-enhancement)
rather than paraphrased from its prose, because they are what the model was
trained to read. What could not be borrowed is the skill's other half: it works
by progressive disclosure over a thousand bundled reference captions, and this
is one chat completion with no filesystem. So the output contract, the
precedence rules and the refusal to invent unstated facts came across; the
retrieval did not.

The precedence rules are the skill's own five rungs, in its order: user
requirements, then section-local directives from bracketed tags, then caption
implications, then reference characteristics, then conservative defaults. Only
the fourth is reworded here, since there are no reference templates on this side
of it. What the skill has no answer for is length — it accepts a desired length
as a constraint and then defines no mechanism for honouring one, its Arrangement
being "a section-by-section timeline" with no times in it. Everything below
about section sizes is a local extension for exactly that reason.

**Lyrics have three possible sources.**

| Source | When | Wiring |
| --- | --- | --- |
| What you typed | The box has words | Straight to `37:13.lyrics` |
| A second director | *Write the lyrics for me* | Node 47's output, linked in by `finalize` |
| A section plan | The box is empty, *Plan the sections* on | Node 47's output through node 48, linked in by `finalize` |

Node 47 does both of the last two — one node class, one client, two system
prompts, and never both jobs on one run — so `lyricistPrompt` decides which
instruction it gets and `finalize` decides what its output feeds.

The lyricist at node 47 is the same node class as the caption director on the
same client, so it needs nothing new installed, and **its user message is node
46's output**. Reading the finished caption is what lets it know the genre, the
tempo, the singer and the arrangement it is writing into without any of that
being described twice. What the song should be *about* travels the other way, in
the system prompt, because the prompt input is taken and the caption is the
better thing to spend it on.

**An empty box means instrumental, and that took some defending.** The caption
is what decides whether there is a voice, so the instrumental instruction now
overrides your own description where the two disagree — the starting description
asks for a soft female vocal, and leaving that in while clearing the lyrics is
the usual way a track meant to be instrumental comes back sung. `Vocal Details`
is written as a refusal with its four lines given verbatim, and a voice is
banned from every other field by name.

**The section plan is transcribed from the caption, and filtered on the way
out.** The lyrics field is Music 3's structural channel — `normalize_lyrics`
keeps every bracketed tag, lowercases it and puts it in the prompt after
`[start]`, and ComfyUI's own template note says the tags "are the only
executable structural instructions; the lyric text itself only conveys mood". An
instrumental sends that channel empty, which is a fair part of why it is the
case that comes back shortest. `SECTION_PLANNER` fills it with a list like
`[Intro - 12 seconds]`, `[Theme - 40 seconds]`, `[Solo - 35 seconds]`,
`[Outro - 15 seconds]`, summing to the target.

Writing it at node 47 is what makes the plan and the caption the same piece of
music: node 47 reads node 46's output, so the sections in the plan are the ones
the caption described, at the lengths it gave them. The app used to compute this
list from the duration alone, which was exact and generic — a row of identical
blocks, with the caption asked to bend its arrangement to fit them.

The reason it was computed is still true and is now handled at node 48. Whatever
lands in the lyrics field is performed; this app never sees node 47's output,
which reaches the encode node over a link inside ComfyUI; and an LLM asked for
tags and only tags writes "Here is the plan:" often enough that the sentence
would eventually be sung, in the one kind of track that is meant to have no
singing at all. Node 48 is a `RegexReplace` — a ComfyUI built-in, so no new pack
— that deletes every line not opening with a bracket. That is safe here and
nowhere else: a plan is nothing but tags, whereas in a lyric sheet the
unbracketed lines are the song. `finalize` therefore wires the filter into the
plan path only.

*Plan the sections* turns the whole thing off, and appears only when neither the
box nor the lyricist is supplying anything.

### Length is a target, and the sampler decides the rest

The slider is the **target**: what the caption, the lyric sheet and the section
plan are each written to fill. Nothing carries it to the model as a number —
`max_audio_frames` never reaches the text, and MiniMax's own generation API has
no duration field either, only `max_new_tokens` — so a target exists in this
system exclusively as structure someone was told to write.

`max_duration` is a different quantity: a **decode limit**. ComfyUI's node hands
it to the autoregressive stage, which generates acoustic frames until it emits
its own end token or reaches that limit, whichever lands first — and the latent
is then sized from what was actually produced, which is why a short song is a
short file rather than a long one padded with silence.

The two used to be one control, which punished the run that went right: a
caption landing the song exactly on the target lost its last bar to a cut-off
placed exactly there. `ceilingSeconds` now derives the limit from the target
with about 15% headroom. Unreached headroom costs nothing — those frames are
never generated — and what it buys is the occasional take that runs slightly
long, which is the better failure.

The slider stops at **five minutes**, MiniMax's own claim for the model. The
node would take six (9000 frames at 25 a second), and that gap is what the
headroom lives in.

That leaves two levers, and they are not the ones you would guess:

- **Structure, in the caption.** The director is told the target and asked
  to spend it as a section list — sections in order, each sized in bars, repeats
  or seconds, that takes that long to play. It is explicitly told *not* to state
  the duration as a fact anywhere, because MiniMax's own caption templates carry
  BPM, key, genre and an arrangement and never a running time, so a line saying
  the piece lasts 3:40 is text the model was not trained to act on. Typing a
  length into your own description has the same problem.
- **Top-k, which acts mechanically.** The end-of-song token is an ordinary
  candidate in the same draw as the audio codes: `_sample_c0` takes the top
  `top_k` of the conditioned logits, softmaxes and samples one. So a song ends
  the frame that token happens to come up, and it can only come up on a frame
  where it ranks inside `top_k`. At 25 frames a second a four-minute take is
  6000 draws, so a per-frame stop chance of even 0.03% ends it early more often
  than not — which is why length varies so much between runs of the same prompt,
  and why no amount of caption wording fixes it. Narrowing `top_k` removes the
  candidate instead of shrinking a probability. 20, then 12; below about 10 the
  music flattens.

Since the ending is a draw, it is decided by the seed — so **Reuse seed** on a
take that came back the length you wanted keeps it while you change other
things.

### The two guidance scales

Music 3 generates in two stages, and each has its own CFG:

| Control | Node input | What it guides |
| --- | --- | --- |
| Caption guidance | `MiniMaxMusic3TextEncode.cfg_scale` | The autoregressive stage that writes the song as tokens — genre, sections, where it ends |
| Sampler CFG | `KSampler.cfg` | The diffusion stage that renders those tokens into audio |

Both ship at 1.7, in this export and in ComfyUI's template, and that coincidence
was once the argument for driving them from one control. It does not survive
reading what they do: raising guidance to hold a length is advice about the
first stage, and carrying the renderer up with it changes how the audio sounds
for no reason anyone asked for. Caption guidance at 2.0–2.5 is worth trying
alongside a lower `top_k`; Sampler CFG is the one to leave alone.

## Upscale

Makes a finished clip larger and sharper, up to 4K, and keeps its sound. Open
it from a result's **Upscale** button, or pick it in the workflow list and
attach any clip up to 1080×1920 and a minute long. **Upscaler** picks how: RTX
Video, the default, or SeedVR2's 7B or 3B, which are labelled very slow. The
graph holds both, and `finalize` deletes whichever was not chosen. The time
estimate is learned per upscaler (`estimateBy`), since one takes seconds and
the other most of an hour, and SeedVR2's files are an optional download
(`optionalNodes`, `--extras seedvr2`).

RTX Video is NVIDIA's RTX Video Super Resolution, through Comfy-Org's Nvidia
VFX node pack, so it needs an RTX card.

It replaced SeedVR2 as the Upscale after an A/B on a 3090 (2026-10-23): a
5-second clip to 1080 px took 8.9 seconds against SeedVR2's 14 minutes, and
4K took 23 seconds. It sharpens what is there and keeps the clip's colour and
shading; SeedVR2 adds more fine texture but warms the colour, raises the
contrast and reshades faces. Neither adds flicker. SeedVR2 stays as a
[choice](#seedvr2).

The node scales by a multiplier, so the graph works one out from the clip's
own size and then resizes to the exact **Output size** — the node rounds to a
multiple of 8. It runs in 49-frame passes of the same Meta Batch Manager as
SeedVR2, so a 4K clip never holds more than a couple of seconds of frames in
RAM. **Mode** is NVIDIA's `ULTRA` (for compressed video, which every H3 clip
is) or `HIGHBITRATE_ULTRA` (for a clean source). **Frame rate** works as below. Expect well under a minute for a 15-second clip at 1080 px.

A music video's upscale uses RTX Video, at 1080 or 4K and 24 or 48 fps.

### SeedVR2

SeedVR2 is slow, and invents fine texture rather than only sharpening — the
one to try on a soft source. It goes up to 1080 px. It is Comfy-Org's SeedVR2 template with four changes, each measured on a 3090
before it went in:

- **It runs in batches** of 97 frames (about four seconds) through
  VideoHelperSuite's Meta Batch Manager. Run on a whole clip at once, the frame
  copies ran a 64 GB machine out of RAM at 1080 px; in batches RAM follows the
  batch, not the clip.
- **Fixed 21-frame temporal chunks**, not the template's "auto". Straight after
  an H3 run, auto sized its chunks to one frame each, so nothing kept the
  upscale steady from frame to frame.
- **1024 px VAE tiles.** The VAE is nearly the whole cost of this graph, and at
  512 px tiles it ran twice as long.
- **The clip's own frame rate and soundtrack** go back on at the end, so the
  result plays exactly as long as the source.

**Upscaler** picks the 7B sharp build (the more natural) or the 3B (less
VRAM, harsher edges). **Colour match** defaults to LAB, which stops colour
wandering between frames — SeedVR2 on its own does, and it shows as blips.
**Frame rate: Double it** adds a RIFE in-between frame for 48 fps; FILM is the
slower alternative under Advanced. Expect about 20 minutes for a 15-second clip
at 800 px on a 3090.

## Edit image

Every picture control has an **Edit** button. Type what should change, press
Enter, and about a minute later the edited picture is in the slot. The strip
of versions under it is undo and redo, **Hold to compare** shows the original,
and **Another take** re-rolls the last change.

It is FLUX.1 Kontext dev on ComfyUI's core nodes, and it is not in the workflow
picker. The choices behind it, all measured on a 3090:

- **20 steps of ER-SDE on the Beta schedule, guidance 2.5** — not the
  template's Euler. In a same-seed grid on a portrait (2026-10-21), Euler at 8
  or 20 steps redrew the man as somebody else with Kontext's smooth, contrasty
  polish; ER-SDE kept his face, skin tone and texture. It costs about a minute
  a run where 8 Euler steps took 18 seconds, plus 10–15 seconds cold. Guidance,
  steps, sampler, schedule and **Redraw** (denoise) are adjustable behind the
  settings button on the edit bar (`image-edit-settings.ts`).
- **fp8 weights**, cast on load, so the model fits beside its T5 encoder on a
  24 GB card.
- **The picture keeps its shape.** It is scaled to 1 MP on a 16 px grid rather
  than snapped to Kontext's preferred sizes, which would change the frame an
  Image to Video run inherits.
- **Your instruction goes in as typed.** No rewrite and no "keep the face"
  suffix: faces held without one.

An edit is queued at the front, so it waits only for the video already
rendering. The result is copied into ComfyUI's input folder and goes into the
next run like any other upload.


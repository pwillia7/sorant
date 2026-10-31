# The prompt rewrite

[← Back to the README](../README.md)

Every generating workflow runs what you type through a language model — the
*director* — before the video or music model sees it. This covers what the
director is told, which model does it and why the picker is split by whether
that model can see your images, and how to skip it.

## Contents

- [The prompt is rewritten before the model sees it](#the-prompt-is-rewritten-before-the-model-sees-it)
- [Choosing the rewrite model](#choosing-the-rewrite-model)
- [Running the rewrite on the ComfyUI machine](#running-the-rewrite-on-the-comfyui-machine)
- [Sending a prompt unrewritten](#sending-a-prompt-unrewritten)

## The prompt is rewritten before the model sees it

Every graph runs what you type through an LLM first, unless you turn that off —
see [sending a prompt unrewritten](#sending-a-prompt-unrewritten), which is the
whole of the escape hatch and is off by default. A
`PrimitiveStringMultiline` node holds the raw input, a `VercelAIGatewayGenerateText`
node expands it into the model's own format, and only that output reaches the
generation node. The image and reference workflows hand their uploads to the
rewrite as well, so it can describe what is actually in frame — those use
`VercelAIGatewayDescribeImage`, which is the same node with an `IMAGE` input.
Both name their inputs `prompt` and `system_prompt` and return the text on
output 0, which is what lets everything else here treat them as one thing. Everything in this
section is about the H3 graphs; the music one runs the same machinery
against a different format, and is described under [Music](workflows.md#music).

**Every director writes MiniMax H3's own structured output format**, which the
model was trained on and reads far more reliably than equivalent free prose:
timed `[Shot N]` markers, a closed camera vocabulary, `(S1)` speaker IDs with
the spoken words inside `<d>[English] ...</d>`, and separate `overall_soundscape`
and `non_diegetic_music` fields. That grammar lives once, in `H3_GRAMMAR`, and
is spliced into all five video directors. The envelope around it is per mode, and there are
three of them — the base three-field form for text-to-video; the same plus an
alignment line naming `<Picture 1>` for the two graphs that start from a frame;
and the six-section full-reference form (`subject_definitions`, `summary`,
`retention_analysis`, `detailed_description`, and the two audio fields) for the
two that run `MiniMaxH3ReferenceToVideo`. The formats are specified in
[MiniMax's own prompt-writing guides](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md),
and in ComfyUI it is the prompt text that has to carry the reference tags —
nothing in the node pack inserts them.

Four rules in there are worth naming, because each exists to stop a specific
thing going wrong rather than to tidy the output:

- **`[unclear]`, on Remix.** That director is told to preserve the source's
  dialogue and has never heard the source — it gets five sampled frames and no
  audio. The guide's rule for reused speech is to reproduce it exactly or write
  `[unclear]` for what you cannot make out, never to guess, so without the
  escape the only available move was to invent a plausible line. A guessed line
  is not a preserved line; it is a new one, spoken in place of what was there.
  **Words in the clip** is the way out of that trade rather than a change to the
  rule: for anything typed there the words are known, so they are quoted and no
  `[unclear]` is written; for everything else the rule stands exactly as it was.
- **A voice inside reused music is not a speaker.** Verbal content that exists
  only within a reused soundtrack cites `<Audio 1>` and gets no `(Sx)`. Remix
  reuses the whole track, so a lyric or a broadcast under the scene was exactly
  what would otherwise be handed a speaker ID.
- **Punctuation inside `<d>` is standardised** to `,` `.` `?` `!` with the
  decoration stripped. Whatever is in there gets spoken, and an emoji is not
  speakable. The words stay verbatim.
- **The style is named in H3's own vocabulary** — Cinematic, live-action,
  2D-animated, 3D CG, claymation, watercolor, vintage film — since every
  director was asked to state a style without ever being given the words the
  model reads most reliably.

**Each director is also told how long the finished video will be**, written into
its `system_prompt` by the duration control like any other param value. Not a
nicety: the format requires every shot after the first to open with an absolute
cut time inside the clip's length, and dialogue has to be speakable in the time
there is. The number written in is the *snapped* length — `effectiveSeconds`
mirrors `FRAME_EXPRESSION`, so a 10s request is described as the 10.13s it
actually comes back as. Remix has no duration control, so the browser measures
the loaded clip instead and that goes in; when nothing has been measured yet the
director is told to write no absolute timings at all.

**More than one control shapes that `system_prompt`,** which takes a little
care, because writing a target is an assignment and the second writer would
otherwise silently discard the first. Rather than picking an owner, every
contributor writes the *whole* instruction, assembled by `directorTarget` from
the complete submission: identical inputs give identical strings, so the order
they run in stops mattering and the number of them is free. That works because
`applyParams` resolves every value before it writes any target — a `transform`
receives the full set alongside its own value, not whatever happened to be
resolved first. The length block always lands last, since it is the hardest
constraint in the instruction and the end is where one is most likely to be
obeyed.

**The two reference-format directors name the facets a reference preserves.**
H3's own reference rewriter states them explicitly — identity, proportions,
costume, accessories, markings, subject style — and then repeats those same
words in `retention_analysis` rather than paraphrasing, so the definition and
the commitment have nothing to drift between. `PRESERVATION_FACETS` carries that
vocabulary into `REFERENCE_DIRECTOR` and `REMIX_DIRECTOR`. Two of the axes are
there because they fail quietly: a stylised character drifts toward ordinary
human build and a drawn one toward photographic, and before this neither
proportions nor the subject's own rendering style had a word anywhere in the
instruction. The facets cover appearance only — expression, gaze and body
language belong to the scene, so a subject can be `fully_preserved` and still do
something it is not doing in the photograph.

**On reference to video you set that per image, across four slots.** The graph
wires `ref_images.ref_image_0` through `_3` and the form offers each slot only
once the one before it has an image, so it opens as a single upload and grows
with what you actually use. Every slot gets a *What to keep* select, and the
four options are the four `retention_analysis` markers in the terms someone
uploading a photograph thinks in:

| What to keep | Marker | What the director is told |
| --- | --- | --- |
| Everything | `fully_preserved` | Only the performance and the setting are the scene's |
| Identity only | `partially_preserved` | Face, build and rendering hold; your prompt dresses them |
| Costume and gear only | `attribute_transfer` | The outfit moves onto whoever the scene casts |
| Style only | `weak_reference` | A manner of rendering, and no subject at all |

The marker used to be inferred from your prose, which is the one part of the
format the director had no evidence for. Your prompt still governs the detail
and still wins outright on a genuine contradiction: the setting says whether the
coat is preserved, the prompt says which coat.

**An unused slot leaves the graph entirely.** `finalize` deletes its variadic
input on both consumers — the video node and the batch that shows the references
to the rewrite — and then the `LoadImage` itself, in that order, since dropping
the node while something still links to it would queue a graph referencing a
node that is not there. Leaving a blank loader wired would fail validation, and
leaving a blank slot *described* would put a phantom subject in the scene, so
the director is told about exactly the slots that survived. Both ends count with
`leadingReferences`, which stops at the first gap: filled slots are contiguous
because the form only reveals them that way, but a value cleared afterwards
would otherwise leave the graph sending one picture while the instructions
described two.

**A short exclusion clause is allowed, and is not the same as a negative
prompt.** H3 has no negative field, so ruling something out happens in the body,
in one plain sentence beside the style — `No dialogue, no crowd, and no camera
movement.` The directors are told to write one only for what a particular scene
would otherwise plausibly produce uninvited, and the standing ban on boilerplate
negatives is unchanged.

**Which system prompt depends on the workflow**, and the difference is not
cosmetic. The three graphs that invent a scene share their creative direction —
`CREATIVE_DIRECTION`, which fills in everything you left unsaid from a one-line
idea — and mostly differ in envelope: `TEXT_DIRECTOR`, `IMAGE_DIRECTOR` and
`REFERENCE_DIRECTOR`. The last of those carries `PRESERVATION_FACETS` as well,
which it shares with Remix rather than with the two it shares its creative
direction with — the axes only mean anything to a director writing
`retention_analysis`. The two that start from a clip do not use it at all,
because that behaviour is actively wrong once a source exists, and they do not
agree with each other either:

- **Remix** runs `REMIX_DIRECTOR`. What you type is a *delta*, and every detail
  the rewrite invents overwrites something the source already decided. So it
  inverts the default — preserve by instruction, and never write replacement
  dialogue merely because someone is speaking, since the clip's own audio
  already holds the words. How much it changes is proportional to how much you
  asked for: a costume note reaches the costume, while "turn this into
  claymation" is licensed to re-render nearly every surface. Sound moves with
  the world — new weather, room or medium changes what the scene sounds like —
  while the words, voices and music hold unless asked otherwise. Its output is
  the six-section full-reference form, which is what makes the balance hold:
  preservation is one line per label in `retention_analysis` carrying a fixed
  marker (`fully_preserved`, `partially_preserved`, `attribute_transfer`,
  `weak_reference`), so `detailed_description` is left free for the change. The
  narrow/moderate/sweeping tiers now pick those markers rather than trying to
  balance two piles of prose against each other.
- **Extend** runs `EXTEND_DIRECTOR`. Nothing about the source changes there;
  time moves forward, and what you type is what happens *next*. Most of it is
  spent on the seam: no establishing shot, no fade, no cut, no resetting
  characters into neutral poses, and motion already underway carried through
  the join. It also holds the previous clip's dialogue to the previous clip.

All of them live in `minimax-common.ts` and are workflow data: treat them as
data, not prose to tidy. The camera vocabulary in particular is a closed list,
and a synonym that reads better is worse.

**None of them is still verbatim from the ComfyUI exports.** The exports emitted
free prose, which the model reads less reliably than its own format, and the
export shared one director across three modes that want three different ones.
`REMIX_DIRECTOR` had diverged even further: it was originally pinned near
"preserve everything", roughly Sora's mildest remix setting, where its own remix
ran a dial from there up to replacing whole buildings — and held that low, a
sweeping request came back as the source with a wash over it, and the soundtrack
never moved even when the world it was recorded in did. If a ComfyUI workflow is
re-exported over any of these files, all of it is lost, so the better fix is to
make the same edits on the ComfyUI side.

Two consequences:

- **The prompt param targets the input node, not the video node.** On these
  graphs `MiniMaxH3ImageToVideo.prompt` is a link, not a value. Writing to it
  would be overwritten at execution time and the user's text would vanish.
- **No graph carries an `api_key`**, and that is deliberate: the node resolves
  one from the ComfyUI host's environment or its own config file, so the key
  never crosses the network from Vercel and never lands in the metadata ComfyUI
  writes into saved files. If the host has no key the rewrite node fails and
  takes the whole job with it, unless the switch below has taken the node out of
  the graph. See [where prompts are rewritten](setup.md#where-prompts-are-rewritten).
- **`model` is a live dropdown, not free text.** The node builds it from the
  gateway's catalog and ComfyUI validates a queued combo against that list, so a
  model id in a graph is a thing that can stop existing. `rewriteModelProblems`
  in `params.ts` fails `check:workflows` on an id the picker does not offer, and
  `check:nodes` checks the offered ten against the live list on your install.

## Choosing the rewrite model

**Rewrite model**, in the dialog behind the header's Gateway button, picks
which model expands what you type — one choice for every workflow, kept per
browser. It never touches the video — that is always MiniMax H3. A retry or a
rerun goes out on the current choice rather than the old run's, so a refused
shot is fixed by switching model there and pressing Retry. Each run still
records the model it used, in its settings.

The list is, per provider family, the newest model that can be shown a picture
and the newest that cannot — usually the same model, in which case the family
contributes one entry. Each is labelled with what it costs per million words out
and marked **free** where it is free. It is built at build time from the
gateway's own catalog by `pnpm sync:models`, so a provider's point release is
picked up by re-running that rather than by editing a graph, and a retired model
drops out of the list instead of failing a queued run — which is not
hypothetical: MiniMax retired the free tier of M3 and the list lost it. The
curation — which families, and why those — is in
`src/lib/workflows/rewrite-catalog.ts`.

Each option carries its price, and the free ones say **free**. A Vercel team
with no card on it still gets $5 of credit a month, so a paid model is not
*refused* on such a key — it is billed against an allowance that runs out
mid-month and then fails a run — and someone who would rather not find that out
at generation time picks a free one. (There used to be a separate **What kind
of key is it?** setting that hid the paid ones; with the list in the same
dialog, the labels do that job.)

The picker is a preference in this browser, so it is offered whether or not a
key has been set from this app and whether or not ComfyUI is answering — the
key may well have been set on the ComfyUI machine instead, through
`AI_GATEWAY_API_KEY` in its environment, which takes precedence over the file.
Only the *key* half of the dialog waits on the pack.

**Every model is offered on every workflow, and half of them cannot see.** On
the four graphs that show their director a picture — the upload, the last frame
of the clip being extended, the reference sheet — the picker is split under two
headings, **Sees your images** and **Text only — writes blind**.

The split is structural rather than cosmetic. The rewrite node comes in two
classes: `DescribeImage`, which is handed an image and whose model dropdown
lists only the models that can take one, and `GenerateText`, which is not and
whose dropdown is every language model there is. Choosing from the second
heading swaps the node for the text one, drops the picture, prunes whatever
existed only to be looked at, and appends a block to the director's instruction
telling it that it has not seen the images and must not invent what is in them —
the labels `<Picture 1>`, `<Video 1>` and `<Audio 1>` stay, because the video
model does receive them and those are how the prompt points at them.

**Nothing about the video changes.** The reference images, the first frame and
the source clip reach MiniMax H3 exactly as before; what changes is whether the
model writing the prompt got to look at them first. Expect less of the result on
Reference to Video, where reading the sheet is most of the director's job, and
very little difference on Text to Video and Music, which never had a picture.

What this buys is the models. Vision is the rarer property and it has nothing to
do with being good at this job or willing to do it: requiring it lost DeepSeek
outright — it ships no vision model at all — and elsewhere picked the wrong
member of a family, offering `glm-5.3-flash` over `glm-5.3` because the faster,
weaker tier is the one that takes images. Most of the open-weight lineages worth
having here are text-only, and that is the same half least likely to refuse a
shot.

Which class each node is, is read off the graph rather than declared beside it —
it is already decided by whether `rewriteNode` was handed images, and a second
statement of the same fact is one that can disagree. `check:workflows` fails a
graph that is *written* holding a model its own node could not be given, that
offers an option nothing can classify, that files one under the wrong heading,
or that would be left with a broken link once a text-only model converted it.

**This is the control to reach for when a generation dies at the rewrite step
for no clear reason.** That is usually a refusal, and a refusal is about the
model, not about you: switch to another and try again. `pnpm check:nodes`
verifies every offered id against the live dropdown on your own install.

## Running the rewrite on the ComfyUI machine

The rewrite does not have to use the gateway, and by default it does not: it
runs on **This ComfyUI machine** — no account, no key, and no hosted model's
content policy, since a director that refuses to describe the shot is a run
that never starts, and that is the gateway's usual failure. A browser that has
not chosen starts there as long as the machine has a local model
(`/api/compat` lists which it has a file for), on the best one it has, and on
the gateway when it has none, rather than failing every run at the rewrite.
A model chosen in a browser that the machine no longer has gives way to one it
does. The header's
Gateway button switches it. The choice is per browser, not per workflow, and
travels with each run as a mode; while it is on, **Rewrite model** leaves the
dialog, since it would be choosing a model nothing uses.

`local-director.ts` does the swap, per run: every gateway director node in the
graph becomes ComfyUI's own `TextGenerate`, with the same system prompt and the
same pictures where the director is shown any. It is **in-process** rather
than a llama.cpp or Ollama server beside ComfyUI, and everything follows from
that. The card is full during a render, so a director cannot stay resident
next to the video models; loaded through `CLIPLoader`, it is a model ComfyUI's
memory manager knows about and evicts before the video models load. A separate
server would be memory ComfyUI cannot see.

There are two models, picked in a bake-off of four on a 3090 (2026-10-31),
through the app's own plan, shot and brief paths and its own parsers. Both can
see, so the graphs that show their director a picture keep doing so, and both
go into `text_encoders/`:

| | Qwen 3.8 27B, W4A8 | Gemma 4 12B heretic, int8 |
| --- | --- | --- |
| Download | `--extras local-director-27b`, 17 GB | `--extras local-director`, 12 GB |
| Card | 24 GB (20 GB at its peak) | 16 GB (14 GB at its peak) |
| A reference brief, cold | 36–43 s | 16–19 s |
| A 21-scene music video's plan / shots | about 110 s / 190 s | about 45 s / 60 s |
| Music video scenes in a different place | 100% | 87% |
| Refusals | the stock model; none in testing | trained out (6 in 100) |

The 27B is the better writer, and the one the app offers first. Gemma is twice
as fast, but writes plainer shots and repeats places across a music video
more. The 27B's multi-token prediction made it no faster, and is off.

At 20 GB the 27B is what fills a 24 GB card, so it needs all of it: with
`--vram-headroom 3` on ComfyUI's launch line — which the setup docs used to
recommend — Dynamic VRAM kept part of it in system RAM and streamed those
weights over PCIe for every token. Three briefs in six took 370–390 seconds
instead of 40, with the same text; without the flag, eight in eight took 40–42.
`pnpm check:nodes` warns when the flag is there.

A Qwen3-VL 8B (dropped scenes from long plans; never released a style
picture's subject) and a Gemma 4 E4B (slower than the 12B on a card without
native fp8) did not make it. Thinking on the 27B doubled its time with no
better reply.

Files are found by **pattern, not name**, because downloads mangle filenames.
An LTX text-encoder packaging of the Gemma weights also matches, but only when
nothing better is installed: it writes the same briefs in about 80 seconds
against 20.

The price is speed and some reliability, against ten or twenty seconds on the
gateway, and both follow the long priority rules less closely than the
gateway's best models. Long JSON replies — the music video outline — can come
back malformed, which the app reads as far as it can and says so. On a 12 GB
card neither may fit beside ComfyUI's working memory; see the
[troubleshooting](setup.md#troubleshooting) rows.

`pnpm check:nodes` reports whether this ComfyUI can run each: a `TextGenerate`
new enough to take a system prompt and the inputs the model sets, and the
model file.

## Sending a prompt unrewritten

**Send my prompt as written**, next to the prompt box on every workflow, queues
a graph with no rewrite node in it at all. The `PrimitiveStringMultiline` the
user typed into is linked straight to whatever was reading the director's
output, and what the model gets is the box, character for character.

Not the same as an empty director. That node would still make the call, still
cost the wait and still return something other than what was typed — the point
is a graph that has nothing to reach the network with, needs no key, and cannot
fail at the rewrite step. It is for someone who has written H3's format by hand,
wants the same words twice, or is working out what the model does with a
particular phrasing. Everything in this section is what it turns off, so a one
line prompt sent this way is a one line prompt.

`director.ts` does the unwiring, and works out what to delete rather than being
told. Everything reading the director's output is repointed at the prompt node,
and then anything no longer reachable from the graph's own output nodes goes:
the rewrite node, and whatever existed only to be shown to it — Reference to
Video's `BatchImagesNode`, Remix's frame stride and the expression that sizes
it. Image to Video's upload stays,
because the sampler reads it too. The roots are read *before* the rewiring, or
the batch node nothing reads any more would look like an output node and be
kept. `check:workflows` runs the whole pass on each graph and fails on a link
left pointing at a deleted node, or on a switch that would do nothing.

It runs after `finalize`, which is the only ordering that works: `finalize`
prunes what the run did not use and writes to nodes this then removes.

The controls that only ever wrote the director's instructions leave the form
with it — Reference to Video's four *What to keep* selects, Remix's measured
source length. That is read off the wiring by `hideDirectorOnly` rather than
listed: a param whose every target is the director's node has no other way to
reach the model. Ones that write the graph *and* the director stay, which is
most of them; the duration still sets the length.

Music has the switch too, on its description, and there it is the caption that
goes through verbatim — Music 3's own three-section format, which is worth
reading `music3-director.ts` for before typing one. Only the caption director is
skipped. Node 47 is a rewrite node as well, but it is there because *Write the
lyrics for me* or *Plan the sections* is on, and those are switches of their
own; with the caption rewrite off it reads what the user typed, which is what
the model is being given as its caption either way.


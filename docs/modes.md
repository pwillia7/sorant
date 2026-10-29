# Turbo, SageAttention, Spectrum and the style switches

[← Back to the README](../README.md)

The switches in each video workflow's settings panel, and what each one does to
the graph. You do not need any of this to run the app — it is here for when a
switch does something you did not expect, or you want to change one.

## Contents

- [Turbo, SageAttention and Spectrum are modes, not more workflows](#turbo-sageattention-and-spectrum-are-modes-not-more-workflows)
  - [The patches](#the-patches)
  - [The 4-step sampler swaps itself in](#the-4-step-sampler-swaps-itself-in)

## Turbo, SageAttention and Spectrum are modes, not more workflows

Every H3 workflow you pick and run directly — the five video ones and Text to
Image; a music video's scenes take Reference to Video's — offers a **Turbo**
switch in the settings panel, **on by default**. It splices a
`MiniMaxH3TurboLoRA` node between the graph's `UNETLoader` and
everything that reads it — in practice `BasicScheduler` and `BasicGuider`, both
of which have to move or the sigmas would be scheduled against the distilled
model while the guider ran the base one. The consumers are found in the graph
rather than listed per workflow, so a re-exported graph cannot silently leave
one behind.

That is the whole difference. The conditioning, the frame maths and the rewrite
stage are untouched, which is why it is a switch rather than five more entries
in the picker. What it changes is the step count: the control's range becomes
4–8 rather than 4–60, because the LoRA is distilled to converge in single
digits and 60 there is not a slower-but-better setting.

**Remix offers it too, and used not to.** The argument for withholding it was
that the graph already samples at 8, the top of the LoRA's range, so the LoRA
would spend quality per step and save no time. That was only ever an argument
about the number that workflow ships at, and it left the other end of the
control broken: at 4 steps the graph takes the pack's four-step form — distilled
sampler, bf16 weights, no Spectrum — and *that sampler exists to be paired with
this LoRA*. Four steps without one is not a usable take, so the cheap end of the
range was reachable and worthless.

**Both `ref2va` workflows ship at four steps**, in turbo, which is the whole of
the point above. Four there is not a cheaper version of the graph — it is the
node pack's complete form, the four-step sampler and the bf16 pair, with the
distilled LoRA under it. Reference to Video was already doing exactly that
whenever a reference track was attached, since a track pins the control to 4; the
default now says so for every other run too. Eight is one drag away for a take
worth the minutes, and brings back the quantised weights, the ordinary sampler
and Spectrum with it.

The turbo estimates are scaled to match: 140 seconds on reference to video and
270 on Remix. Both come off the fit the old numbers already implied — 300 at
twelve steps and 220 at eight puts a step at about 20 seconds and everything that
is not sampling at about 60 — and both are replaced by the machine's own median
after one finished run in that combination.

**These are defaults for a fresh browser only.** The stored params blob keeps its
key across releases, because it holds what someone actually typed, so a step
count that has already been written stays where it was. Someone who has run the
app before gets 4 by dragging the control to it once, not by upgrading —
`DEFAULTS_VERSION` moves the *switch* keys and deliberately does not touch this
one.

**The LoRA is always merged, never applied at run time.** The node pack's
`low_vram` input picks between the two, and the app sets it on and offers no
switch. Bypass, the pack's default, crashed a 3090 box even with
`--vram-headroom 3`, while merged runs completed at the same s/it. The machine
restarts themselves turned out to be Windows' GPU timeout (TDR), fixed on the
ComfyUI host with `TdrDelay` — see [`docs/agent-setup.md`](agent-setup.md).
Bypass has not been retried since that fix. The pack says merging is slightly
softer on a quantized base.

**On the two graphs that run `ref2va` — reference to video and Remix — check a
turbo take against a standard one before you trust it for a likeness.** The LoRA is distilled against `fl2va` and its author
[does not officially support](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora/discussions/10)
`ref2va` yet — "not yet but planned", with reports of identity reference
degrading. It is offered anyway because it demonstrably works here; the first
turbo mode in this app was exactly that graph. Remix is the same model and gets
the same caveat — more sharply, if anything, since holding to a source clip is
what it is for. The spec still lists the models
the LoRA may land on, so a graph on some third UNET fails `check:workflows`
rather than finishing a run that looks subtly wrong.

### The patches

Under the Turbo switch are three more. **The same six offer the first
two. SageAttention starts on; Spectrum starts off, because its forecast steps
leave visible faults in too many takes:**

- **SageAttention** splices KJNodes' `PathchSageAttentionKJ`, running attention
  on quantised kernels instead of the default. The class name's misspelling is
  the pack's. It needs `sageattention` installed in ComfyUI's Python as well as
  the node, and it compiles on the first run of a session, so judge what it saves
  on the second take.
- **Spectrum** splices `SpectrumApplyMiniMaxH3`, which forecasts sampler steps
  from the ones already taken instead of computing every one in full.

**Use additional content LoRA** is the third, on **the same six**, and it
starts **off**, because it is a look rather than a way of running the model. It splices ComfyUI core's
`LoraLoaderModelOnly` directly behind the turbo LoRA, holding whichever LoRA is
picked from the dropdown under it. It needs no node pack, only the files in
`models/loras/`.

**The list is curated by hand**, in `H3_CONTENT_LORAS`. A `models/loras/`
listing is mostly LoRAs for other model families — SDXL, Flux, Wan — every one of
which would splice into an H3 graph without an error and produce nothing but
noise, so the dropdown offers only what has actually been run on these graphs.
Today that is one entry, **VHS tape**. Adding another is an entry in that array
and nothing else: no new switch, no new storage key, no new checks.

Each entry owns what is true of *that* LoRA rather than of the switch — the file,
the checkpoint it needs, the strength it converges at. Hanging those off the
switch would make the first LoRA's answers silently apply to every one added
later. The switch owns only what they share: the loader class, which input the
file goes in, and where in the model chain it sits.

Two things follow from an entry's declaration.

**It changes the checkpoint.** MiniMax-H3 LoRAs are made for fp16/fp8 bases, and
the `fl2va` graphs ship on `minimax_h3_fl2va_pruned_int8_convrot` — the base the
official ComfyUI H3 tutorial defaults to, and a *rotated* one. A LoRA loads into
a rotated base with no error at all and then produces warped faces, melting limbs
and objects that vanish mid-shot, which is worse than a failure because the run
finishes. So the switch points the `UNETLoader` at a checkpoint the chosen LoRA
supports for as long as it is on, and puts the rotated one straight back when it
is off. That makes such a take cost noticeably more than a plain one; the learned
estimate accounts for it on its own, since `modeKey` buckets by which switches
were on. The same applies to `*_nvfp4` and `*_w4a8` — each entry declares the
bases it accepts, and *both* sides of the **Lighter base** switch are checked
against that list, so a base outside it fails `check:workflows` rather than a
render.

An entry declares one checkpoint **per model family**, not one checkpoint. H3
ships two backbones — `fl2va` on text to video, image to video and Extend, and
`ref2va` on Reference to Video and Remix — each with its own non-rotated build,
and the same LoRA file wants a different one on each. Which applies is decided by
what the graph already loads, so one entry in the dropdown covers every workflow
instead of a near-duplicate per family.

**Lighter base** chooses between two checkpoints where a family has two. For VHS
tape on `fl2va`, off is `minimax_h3_fl2va_bf16` and on is
`minimax_h3_fl2va_pruned_fp8_scaled` — much smaller and much easier on VRAM for
some quality. Both are non-rotated, so neither side can produce the failure
above; it is a straight quality-for-memory trade, and the option to take if bf16
will not fit or has not been downloaded. On `ref2va` there is no scaled fp8 build
to offer, so the switch does not appear there at all.

**On the reference workflows this pairing is ours, not the LoRA author's.** The
model card lists `fl2va` bases only and says the LoRA is designed for
text-to-video and image-to-video. What is established is that it applies: on
`minimax_h3_ref2va_bf16` all 104 of its modules attach with no unmatched keys —
the same number the card reports for `fl2va` — and a same-seed pair with and
without it differs. Whether the look is worth having on a graph whose job is
holding a likeness is a judgement to make from takes, so compare one before
trusting it, exactly as with Turbo on those graphs.

`minimax_h3_ref2va_bf16` is also what both those graphs already load at 4 steps,
which is not a coincidence to rely on silently: `validateWorkflow` refuses a
declaration where the step count's own weight swap would override a LoRA's base,
because that run would load the wrong checkpoint while the form said otherwise.

**It has a trigger, and the LoRA is inert without it.** `vh5tape` has to be the
first thing in the prompt, followed by a damage-tier phrase, then the scene —
that is what the LoRA was trained to answer to. The weights apply either way, so
a run without the trigger looks like it worked and is merely a slightly
different take, which is the worst kind of wrong. So the switch splices a
`StringConcatenate` (ComfyUI core, no pack) between whatever produces the prompt
and the node that consumes it, putting the trigger in front deterministically.

Deterministically, and not by asking the prompt director: the director is a
language model rewriting a sentence, and "begin your output with exactly this" is
a request it can decline, reword, or bury mid-sentence. A join node cannot. It
also means the trigger survives **Send my prompt as written** — bypass rewires
the *producer* feeding the join, so the join and its consumer are untouched.

**Tape damage** picks the graded phrase, verbatim from the model card: Light,
Medium or Heavy. It defaults to Medium rather than the first offered, because
Turbo's four-step sampler already softens the grain and the stacked strength is
half — starting at Light would stack three things pulling the same way and show
almost nothing, which reads as "the LoRA is broken" rather than as a setting.

**It has a strength.** For VHS tape the two LoRAs perturb the same weights andNeither the strength nor the base choice is a param — the inputs they write
belong to a node that is not in the stored graph — so both ride in the run's modes. Both are keyed by the *entry's* id rather
than the switch's, so each LoRA remembers its own settings and switching between
them does not carry a number into a range that may not contain it. Which LoRA is
selected is keyed by the switch, and all three are remembered once for the whole
app rather than per workflow.

The browser is never given a model filename: each entry's `file`, and both sides
of its `base`, are stripped on the way out for the same reason the graph is. The
controls travel as ids and booleans, and the server resolves which files they
mean. The finished job records the id *and* the filename — the run detail shows
the filename, since that is what explains a difference between two takes and
keeps meaning the same after the list changes, and **Reuse settings** restores
from the ids, since the browser cannot work a control back out of a filename it
never saw.

`pnpm check:nodes` reports every LoRA in the list, and every checkpoint it can
run on, as **optional** — the switch is off by default, the list is meant to
grow, and nobody downloads all of it, so demanding them would leave the check red
on a correctly set-up machine.

These are plain on/offs rather than Turbo's two-position control, because off
really is their absence: the node is only in the graph when the switch is on, so
turning them all off gets you back to a graph that needs none of these packs —
which is the thing to try first if a fresh install fails on every workflow. All
three are described in `src/lib/workflows/patches.ts` as a list rather than as
named fields, since they differ only in which node they carry and in the two
things `PatchDef` grew for the LoRA: `base` and `strength`.

They live behind a collapsed **Model** heading, closed by default,
because none of them is a per-shot decision — they answer questions about the
machine and the install, and once answered they are in the way. The heading
carries a summary of what is on, so shutting the section does not hide the fact
that all of them ship enabled. Turbo stays outside it: it moves the step range
the form below shows, and a control cannot sensibly hide from what it
reconfigures.

**Where the defaults live.** Each switch declares its own starting position —
`defaultOn` on the turbo spec and on each patch — and the settings panel is the
only thing that overrides it, per workflow, remembered in `localStorage`.
Changing a default in code cannot reach a browser that has already run the app,
because the stored maps are written back in full on every load and so always
have an explicit entry: `DEFAULTS_VERSION` in `src/lib/param-storage.ts` moves
the storage keys when that needs to happen, forgetting deliberate choices once
in exchange.

Remix offers all three, as every video workflow now does.

**They stack, in a fixed order.** Turbo's LoRA attaches to the raw diffusion
model, the attention patch swaps the kernel on whatever weights are in play by
then, and Spectrum wraps whatever model is going to be sampled — so with all
three on the chain is `UNETLoader → MiniMaxH3TurboLoRA → PathchSageAttentionKJ →
SpectrumApplyMiniMaxH3 → BasicScheduler`/`BasicGuider`, which is what the ComfyUI
export they came from does. The order lives in `SPLICE_ORDER` in
`src/lib/workflows/model-chain.ts` rather than in the order the switches happen
to be applied, because any other arrangement would fail nothing and quietly
sample something none of the nodes was meant to produce.

**The two `ref2va` graphs refuse Spectrum at 4 steps.** That four-step form is
the ComfyUI export that actually works — distilled sampler, bf16 weights, no
forecaster — so the switch is left out of the run rather than spliced into a
chain it was never part of. It is refused, not turned off: the setting is kept,
the switch shows as off with the reason under it, and it comes back the moment
the step count moves. On Reference to Video a reference track pins the steps to
4, so a track means no Spectrum without a second rule saying so. The declaration
is `suppresses` on the workflow's `stepSampler`, beside the sampler swap and the
model swap it belongs with, and `check:workflows` rejects a name the workflow
does not offer.

Remix carries the same declaration, and got it later than Reference to Video
did. It is the same model — `minimax_h3_ref2va` through
`MiniMaxH3ReferenceToVideo`, handed a reference to work over — so its four-step
form is the same form, and running the quantised pair under the distilled
sampler there was an accident of which graph the swap happened to be worked out
on. What did **not** carry across is the pin: Reference to Video holds the steps
at 4 while a track is attached because the quantised pair failed on one, while
Remix has audio on every run and works with those weights at
every count the control offers — which is evidence they take a clip's audio
perfectly well. Its default is 4 like the other graph's, but as a default rather
than a rule: dragging the control up is allowed there and refused under a track.

**There is no sigma-shift node here, and that is the same as running the
model's own.** ComfyUI's `MiniMaxH3SigmaShift` — shown in the node menu as
*ModelSamplingMiniMaxH3* — sets the video and audio flow shifts the sampler
schedules against. None of these graphs has one, and neither does ComfyUI's own
`video_minimax_h3_r2v` template they came from. Its defaults, `shift_video:
12.0` and `shift_audio: 3.0`, are exactly the `sampling_settings` H3's entry in
`comfy/supported_models.py` already carries, so at those values the node sets
what the sampler was going to use anyway. Every run here is at 12/3, at four
steps and at every other count, and there is nothing to switch off. Adding one
would only be worth it to run *different* shifts, and it would be a node in the
stored graph rather than a switch — so its four-step rule would be an unwiring,
the way `directorBypass` unwires the rewrite, and not the `suppresses` above,
which speaks for nodes that are only there when a switch puts them there.

That is also why `applyParams` coerces before it splices, and why the response
reports the patches a run actually got: the history names the modes a generation
used and the estimate is learned per combination of them, so recording a switch
the graph did not have would put the run in the wrong bucket and name a node
that was never there.

Unlike Turbo, neither patch retunes a control or declares a time estimate. What
they cost is a fact about your machine, and the progress bar learns it from your
own history — which counts each combination of switches separately, so a
Spectrum run is never paced against a standard one's median.

The graphs on disk stay verbatim from their ComfyUI exports — every node is added
to a clone on the way to the queue, in `src/lib/workflows/turbo.ts` and
`patches.ts` over the shared splice in `model-chain.ts`. Every form is checked:
`pnpm check:workflows` proves each splice resolves on its own, that turbo's lands
on the right model, and that they all still work stacked; `pnpm check:nodes` asks
ComfyUI about each patched graph as well as the stored ones, since those nodes
and turbo's LoRA file are the only pieces that need packs nothing else does.

### The 4-step sampler swaps itself in

The turbo pack also ships `MiniMaxH3TurboSampler`, built for exactly four steps —
its node takes no inputs at all, because the schedule is inside it. **Whenever
the steps control is on 4, that sampler replaces the graph's `KSamplerSelect`.**

This is not a fourth switch, deliberately. Four steps is not a setting that
happens to pair well with this sampler; it is the step count the sampler exists
for. Making it a thing to turn on would only be an opportunity to get the pair
wrong, so the form says what happened rather than asking: a short accented line
appears under the steps slider at 4 and goes away at every other value. Nothing
is remembered between runs — the control is the whole state.

**On Reference to Video, four steps is a whole form of the graph rather than one
node.** The same trigger also loads the bf16 diffusion model and text encoder in
place of the quantised pair, and refuses the Spectrum switch — which is the
ComfyUI export that actually works there, node for node. All three hang off the
one `stepSampler` declaration, so there is one trigger and one note rather than
three rules that could disagree about which four-step graph this is; `models`
and `suppresses` are covered under [the reference workflow](workflows.md#create-video-from-a-finished-track)
and [the patches](#the-patches). It is also why a reference track pins the steps
control to 4: that is the only form of the graph a track survives, and pinning
the number is what makes the rest of it follow.

It fires on the value alone rather than on the value *and* Turbo, even though
four steps is only really useful with the LoRA applied. "Four steps uses the
four-step sampler" is a rule you can hold; "four steps uses it, unless Turbo is
off, in which case it quietly does not" is not.

The swap keeps the node's id rather than adding one and deleting the old, which
is how the ComfyUI export does it. The two graphs are the same graph, and reusing
the id means every link that pointed at the sampler still does — no rewiring to
get wrong, nothing left behind. It lives in `src/lib/workflows/step-sampler.ts`,
and `check:workflows` asserts both halves of the coupling: that the graph has
exactly one `KSamplerSelect` to stand in for, and that 4 is inside the steps
range in *both* modes. The second matters because that failure is silent —
a swap that can never fire would leave every four-step run sampling with the
wrong sampler and coming back a worse video rather than an error.


# Working on Soran’t

[← Back to the README](../README.md)

How the app is put together, how to add a workflow, and the parts of the
behaviour that are worth knowing before you change them. Agents working in this
repo should also read [`AGENTS.md`](../AGENTS.md).

## Contents

- [How it fits together](#how-it-fits-together)
- [Adding your own workflow](#adding-your-own-workflow)
- [Queueing, history and leaving it running](#queueing-history-and-leaving-it-running)
- [ComfyUI-Login authentication](#comfyui-login-authentication)
  - [How auth failures surface](#how-auth-failures-surface)
  - [If a correct token is still rejected](#if-a-correct-token-is-still-rejected)
- [Branding and icons](#branding-and-icons)
- [Scripts](#scripts)
- [Releasing](#releasing)
- [Known limits](#known-limits)
- [Agent files](#agent-files)

## How it fits together

```
browser ──HTTPS──> Next.js on Vercel ──HTTP──> ComfyUI (your host, via COMFY_URL)
                   route handlers                 /prompt /history /queue /view
```

Everything goes through server-side route handlers. That is not decoration:

- The page is served over HTTPS and ComfyUI is plain HTTP. A browser refuses to
  call an `http://` origin from an `https://` page, so a direct client→ComfyUI
  call cannot work from a deployed build. The proxy sidesteps it entirely.
- `COMFY_URL` never reaches the client, so the endpoint is not published in your
  JavaScript bundle.
- Video is streamed through `/api/media`, with `Range` forwarded so seeking in
  the player works.

Generation is **submit-then-poll**, not a held-open request. `/api/generate`
returns as soon as ComfyUI accepts the job, then the client polls
`/api/status`. A multi-minute render would outlive any function timeout, and
ComfyUI already owns the queue and history, so there is no server-side job
state to keep.

## Adding your own workflow

The registry lives in `src/lib/workflows/`. A workflow is the ComfyUI graph
**verbatim** plus a declaration of which node inputs the UI may drive — the
graph is never rewritten by hand.

`archive/` holds superseded graphs that are worth keeping to compare against.
They are complete workflow definitions and still typecheck, but nothing imports
them, so they are neither validated by `check:workflows` nor bundled. Adding one
back is a single line in `index.ts`.

1. In ComfyUI: **Workflow → Export (API)**. You get a flat map of
   `node id -> { class_type, inputs }`, where `["1", 0]` means output 0 of node 1.
2. Drop it into a new file next to `minimax-h3.ts` as the `graph`.
3. Declare `params`, pointing each control at the node inputs it writes:

```ts
{
  id: "prompt",
  label: "Prompt",
  type: "textarea",
  default: "",
  group: "Prompt",
  targets: [{ node: "3", input: "text" }],
}
```

One control can drive several inputs, and a `transform` on a target derives what
each one receives — so a single value can go to one node as a number and to
another baked into a formula string. A `transform` is handed the whole
submission alongside its own value, so an input can depend on several controls;
where it does, have each of them write the complete value rather than a piece of
it, because a target write is an assignment and the last one wins. The prompt
directors' `system_prompt` is the worked example.

4. Register it in `src/lib/workflows/index.ts`.
5. Run the validator:

```bash
pnpm check:workflows
```

It resolves every `target` against the graph and fails on anything stale, so a
bad mapping surfaces immediately instead of sending a subtly wrong job to the
GPU. The same check runs on `/api/workflows` and again before every submit. It
also catches the couplings that are invisible in a diff:

- that turbo's LoRA lands on a model it belongs on;
- that each patch still finds something to sit in front of once the switches
  above it have moved the wiring;
- that the 4-step sampler has exactly one `KSamplerSelect` to stand in for, that
  4 is still inside the steps range in both modes, that the loaders its weights
  swap into exist and take the input named, and that a switch it refuses is one
  the workflow actually offers;
- that a pin names a control that exists and holds a value that control accepts
  in both modes;
- that the director bypass names a node something reads, that the prompt node it
  stands in is the one that director takes its `prompt` from, and that the pass
  leaves no link pointing at a node it deleted;
- and that a graph driving a prompt director declares a `duration` or
  `source_seconds` param — the length block is found by param id, so renaming
  one would otherwise drop it from the instruction and the only symptom would be
  shot cut times landing past the end of the video.

Param types available: `text`, `textarea`, `number`, `slider`, `select`,
`toggle`, `seed`, `image`, `video`, `audio`, and `measured` for a value the
browser reads off a loaded clip rather than the user setting it. `group` sets
the section heading and `advanced: true` tucks a control behind that group's
disclosure.

Four more fields on a param, each of which exists for one of the workflows
above:

- **`revealedBy`** keeps a control out of the form until its condition holds —
  the chain of optional reference slots, each waiting on the one before. A bare
  id asks whether that param has a value at all; `{ param, is }` asks whether it
  has one particular value, which is what a control belonging to one option of a
  select needs. A list means all of them have to hold: the reference trim's
  length waits on a track being attached *and* on the trim being set to a
  length, so a stored answer cannot leave it sitting in a form with no track.
- **`hiddenBy`** is the same question backwards, takes the same two forms, and a
  list there means any one of them hides — the music workflow's *Plan the
  sections* is hidden by both the lyrics box and the lyricist, so it appears
  only when neither is supplying words. The asymmetry is deliberate: waiting is
  a chain of things that must be true, standing down is a list of reasons any of
  which is enough. Both are presentation only. A hidden control still submits
  its stored value; what stops it reaching ComfyUI is `finalize`.
- **`pinnedBy`** is the third of that family and the only one that is *not*
  presentation only: while the named param is set, the control shows the pinned
  value, takes no input, and submits that value whatever was stored under it —
  `applyParams` writes it over the submission after coercion, so a number left
  over from an earlier run cannot get past what the form is showing. Reference
  to Video's steps control is pinned to 4 by its reference track, because that
  is the only step count the graph takes one at. The stored value is untouched
  and comes back when the pin lifts.
- **`makes`** is the noun the Generate button uses — `"video"` unless you say
  `"music"`.

On the workflow itself, past `graph` and `params`: `turbo`, `patches` and
`stepSampler` are the modes described [in the modes guide](modes.md#turbo-sageattention-and-spectrum-are-modes-not-more-workflows);
`clipTarget` makes it the destination of one of the hand-off buttons; and
**`directorBypass`** names the rewrite stage a *Send my prompt as written*
switch takes out, which is the [section on that](prompt-rewrite.md#sending-a-prompt-unrewritten).
It is the one place a param may declare no `targets` at all, since its whole
effect is that a node stops being in the graph.

**`finalize` is for structural changes params cannot make.** Params write values
into inputs that already exist; `finalize` runs on the cloned graph, with the
resolved values, and can delete nodes and inputs or swap a value for a link. It
is last but one: the director bypass runs after it, because that pass prunes
whatever was only ever shown to the rewrite and `finalize` is still writing to
some of those nodes on its way past.
Both non-obvious cases in this repo are there: reference slots removing their
loaders when unused, and the music graph pointing `lyrics` at the lyricist's
output instead of at a string. The visibility rules above and `finalize` are
deliberately independent — one decides what the form shows, the other decides
what ComfyUI is sent.

The same visibility rules are applied to the record of a past run: a control the
form was hiding took no part in it, so `paramVisible` is shared between the form
and the settings modal. That is what stops a lyric sheet sitting unused in a
hidden box being read back as the words a track was sung with.

## Queueing, history and leaving it running

**The form never locks.** Submitting appends to a list rather than taking a
global lock, so you can queue several runs and ComfyUI works through them in
order. Each carries its own progress, queue position and cancel button.

**Cancel targets a specific prompt.** `POST /interrupt` with no body is a
*global* interrupt in ComfyUI — it kills whatever happens to be executing,
which with a queue may not be the job you cancelled. Newer ComfyUI has
`POST /api/jobs/{id}/cancel`, which handles either state in one idempotent
call; older builds fall back to de-queueing *and* interrupting with an explicit
`prompt_id`, both of which are no-ops when they do not apply. Either way
nothing else in the queue is touched.

**Progress is an estimate, and the API cannot do better.** A running job in
ComfyUI's HTTP API reports only its id, status, priority and creation time —
no step counts and no ETA. Step-level progress exists solely on the WebSocket,
which Vercel functions cannot proxy. So the remaining-time readout is the
median render time of that workflow's last few runs on this device, measured
from when rendering *started* rather than when the job was queued.

**History is kept per device** in `localStorage`, with each run's prompt,
settings and result. Only the *reference* is stored, never the video: the file
stays on the ComfyUI box and streams through `/api/media` on demand. Storing
media here would exhaust the few megabytes localStorage allows after a couple of
clips. The trade is that an entry stops playing if ComfyUI's output directory is
cleared.

**The limit is 2 million characters of history, not a number of runs.** A run is
not a fixed size — about 1KB for an ordinary prompt, about 17KB for one written
to the 8000-character maximum — so a flat count was really a storage limit that
moved by a factor of twenty depending on how much you type. The budget holds
around 1800 ordinary generations and degrades the right way: write enormous
prompts and you keep fewer of them, rather than getting a broken write. Anything
still queued or running is kept regardless, because its entry is the only record
of what to poll and what to cancel.

Characters rather than bytes, because that is the unit that matters. An origin
gets about 5MB, but browsers meter it in UTF-16 — two bytes a character — so the
real ceiling is nearer 2.5M characters for everything this app stores. A budget
written as "5MB" would ask for roughly twice the quota and simply be refused.
Unlimited is not on the table either: `localStorage` writes are synchronous and
throw past the quota, and a cap is what keeps the failure "the oldest entries
went" rather than "history silently stopped saving".

Compute is no longer an argument against a long history, though it used to be.
This blob was stringified on every poll tick, so its size was paid every 1.5
seconds for as long as a render ran. A tick that changes nothing now returns the
same array and writes nothing, and the history regroups on the calendar day
rather than on the second — so what is left is a parse on load, a few
milliseconds at this size.

The list is **grouped by the day a generation was started**, newest day open and
the rest collapsed, so a long history reads as an index rather than a wall. Days
are worked out from local calendar date parts rather than by dividing the
timestamp, because a day is not reliably 24 hours long once daylight saving is
involved. Each day header can download or delete its generations in one go,
both behind an inline confirmation — deleting only forgets where the files are,
which is why the prompt says so.

**Anything worth keeping can be starred**, from the row in the history or from
the finished result on the stage, and starred generations collect in a
**Favorites** section above the days. It is a local organising flag and nothing
more: the file on the ComfyUI box is untouched either way, and there is no
server to sync it to. What it changes is what happens *around* the entry — a
favourite is lifted out of its day rather than copied above it, so nothing
appears twice and a day's Download and Delete still act on exactly the rows that
day is showing; **Clear finished** spares favourites, which is most of what
marking one is for; and when the storage budget has to shed history, favourites
are kept ahead of ordinary entries. They are not exempt from the budget the way
an in-flight job is — there can be any number of them — so what degrades is
"the oldest favourites went", not the write itself. The section has no bulk
delete, on the grounds that one click that forgets everything you marked to keep
is the opposite of what marking it meant; the row's own remove button still
takes them one at a time.

The settings kept are the **resolved** ones — what the server made of the form,
not what the form held. That distinction is the point: a run submitted with the
seed on "random" records the number it actually got, which is what makes the
take reproducible. **Use settings** on the stage opens them for whichever generation
is being viewed, failed ones included, where the first question is usually what
it was run with.

Every written field is shown, each under its own heading and with its line
breaks intact — the description, the lyrics, whatever the workflow declares —
rather than only the prompt. **Reuse settings** in that modal loads the lot back
into the form and switches to the workflow that made it, mode switches included,
merged against the workflow *as that mode has it* so a steps value from a turbo
run lands in the turbo range. Not the seed: varying a take is what this is for,
and reproducing one exactly is the button on the result. Nothing is submitted.

That record outlives the workflow that made it. Params get renamed, removed or
added between a run and the reading of it, so the modal labels what the current
definition still recognises and falls back to the raw id for the rest, rather
than dropping values someone is trying to reconstruct from — and the button is
withheld entirely when that workflow is no longer registered, since there would
be nothing to load into.

Active jobs are polled in **one batched request** regardless of how many are in
flight — `/api/status?promptIds=a,b,c` reads the queue once and resolves every
id against it, so a deep queue does not multiply load on the GPU box.

**A job is given up on if the connection goes, rather than polled forever.**
Failed status checks are retried with a backoff, and once there have been at
least three in a row spanning at least 45 seconds — roughly a minute in practice,
either way — every job in flight is marked failed and sent a cancel. Both
conditions are needed: a refused connection answers instantly, so a count alone
would kill a good render over a few seconds of nothing, while an unreachable host
is usually blackholed rather than refused, and a single check then burns the
route's whole 20-second ComfyUI timeout, which is not evidence of anything yet.

The cancel is best effort and goes out after the job is already marked, because
if ComfyUI is unreachable the cancel fails exactly as the status checks did and
waiting on two more timeouts to be told what you already know is worse than
being told the run may outlive the tab. When it does land — the box is up but
something in between is not — it saves the GPU several minutes on a clip nothing
will collect. Either way the failure names what happened, rather than leaving a
progress bar filling against an estimate for a run that stopped being watched.

**Desktop notifications.** The bell in the header opts in (the permission prompt
has to be tied to a click, which is why it is a button). Each finished or failed
run notifies once, and only while the tab is hidden — if you are watching the
progress bar already, it would just be noise.

The ceiling: the Notifications API needs the page alive, so this covers a
backgrounded tab, not a closed one. Reaching a closed tab needs a service worker
and a push service, which is a separate piece of infrastructure.

Browsers also throttle timers in hidden tabs — to roughly once a minute after a
few minutes — so a notification can lag the actual finish by up to that long.
The poll fires immediately on `visibilitychange`, so the moment you look at the
tab the state is correct regardless.

## ComfyUI-Login authentication

Set up for [liusida/ComfyUI-Login](https://github.com/liusida/ComfyUI-Login). Every
outbound call carries `Authorization: Bearer <COMFY_API_TOKEN>`. The token value is
the bcrypt hash the node prints to the ComfyUI console when you set a password.

The Bearer header is used rather than the `?token=` query form the README also
offers, because a bcrypt hash contains `/` and `+` that need URL escaping, and
because query strings land in access logs.

### How auth failures surface

An auth failure from ComfyUI is reported as **502, never 401**. A 401 from this
app's own API means the caller's `APP_ACCESS_TOKEN` is wrong, and the UI reacts by
clearing it and showing the token gate — which would be entirely the wrong
response to *our* token being misconfigured.

Three refusal shapes are handled, each with its own message, and all report
`reachable: true, authorized: false` so the header pill reads **Auth failed**
rather than **Offline**:

| ComfyUI responds | Detected as |
| --- | --- |
| `401` / `403` | token rejected or missing |
| `302 → /login` | redirect chasing is disabled, so this cannot masquerade as success |
| `200` with `text/html` | login page served instead of JSON |

The last two matter because without the guards a login wall would either return
HTML through a followed redirect or parse-error as `Unexpected token <`.

Verified against a mock reproducing all four cases, and then against a live
instance with the login node enabled: unauthenticated calls redirect to
`/login`, a wrong token is rejected, and the correct token authenticates.

Note that some builds of the login node return **302 for every `Accept` header**,
including `application/json`, where newer source returns 401 JSON to non-HTML
clients. Following that redirect yields `200 text/html`, which is precisely the
`Unexpected token <` the redirect guard exists to prevent.

### If a correct token is still rejected

Bearer auth sits behind a CORS condition in the plugin:

```python
if args.enable_cors_header is None or args.enable_cors_header == '*' or args.enable_cors_header == request.headers.get('Origin'):
```

Server-side `fetch` sends no `Origin` header, so starting ComfyUI with
`--enable-cors-header <specific-origin>` makes the Bearer check unreachable and
a valid token fails. Drop the flag or set it to `*`.

## Branding and icons

The mark is a film frame with the play triangle entering from the left and
perforations punched out of the right edge. It ships as artwork rather than as
code to improve: the same geometry is in `src/components/sorant-logo.tsx`, in
`src/app/icon.svg`, and in the PNG app icons, and none of those can be
regenerated from the others.

**The wordmark is live Geist text**, not a picture of one — so it stays
selectable and stays the page's `<h1>`. The apostrophe is the one piece of
colour in the header, on the same `--accent` token everything else signals with.

The mark's three blues are fixed on both themes. Its play triangle is the
exception and takes `currentColor`: at `text-fg` that is near-black on light and
near-white on dark, which is what lets one component serve both without a second
copy to keep in step.

Everything else is a Next file convention, discovered by filename with no
declaration anywhere:

| File | What it becomes |
| --- | --- |
| `src/app/favicon.ico` | the tab icon, 16/32/48/64 |
| `src/app/icon.svg` | the modern tab icon, any size |
| `src/app/apple-icon.png` | the iOS home-screen icon, 180×180 |
| `src/app/opengraph-image.png` | the link preview, 1200×630 |
| `src/app/manifest.webmanifest` | the installable-app manifest |
| `public/icons/*` | the 192, 512 and maskable icons the manifest names |

The one thing that is declared is `metadataBase` in `src/app/layout.tsx`, because
an Open Graph URL has to be absolute and this repo cannot know the domain it
will be deployed to. `siteUrl` in `src/lib/env.ts` reads Vercel's own
`VERCEL_PROJECT_PRODUCTION_URL`, falls back to the per-deployment `VERCEL_URL`,
and then to localhost — which is what `next dev` wants anyway.

## Scripts

| Command | |
| --- | --- |
| `pnpm dev` | Dev server |
| `pnpm build` | Production build |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm check:workflows` | Validate param→graph mappings. Needs nothing but this repo. |
| `pnpm check:nodes` | Ask your ComfyUI whether it has the classes and models the graphs name, whether it holds a gateway key, and whether every offered rewrite model is still in the catalog. Needs `COMFY_URL`. |
| `pnpm sync:models` | Rebuild the rewrite-model list from the gateway's live catalog. Also runs before every `pnpm build`. |
| `pnpm requirements:write` | Rewrite `machine-requirements.json`. `check:workflows` fails while it is stale. |

## Releasing

Installs are updated by release, so cutting one is what tells everyone else
there is something to update to. The app checks
`github.com/pwillia7/sorant/releases/latest` every few hours and shows an
**Update** notice when its tag is newer than the deployed `package.json`
version.

1. Bump `version` in `package.json` (semver; the tag is `v` plus it).
2. `pnpm requirements:write`, `pnpm check:workflows`, `pnpm typecheck`.
3. Commit, push, then tag and publish:

   ```bash
   git tag v0.3.0 && git push origin v0.3.0
   gh release create v0.3.0 --title "v0.3.0" --notes-file notes.md
   ```

4. **End the notes with a "ComfyUI machine changes" section**, and work it out
   rather than from memory: compare the fingerprint in
   `git show v<previous>:machine-requirements.json` with the new one. The same
   means write "None. This update is app-only." Different means
   `git diff v<previous>..v0.3.0 -- machine-requirements.json` and say what each
   change asks of the machine: a pack to install or update, a model to download
   with its `models:download --workflows` line, or a newer ComfyUI.

The notice reads the new release's `machine-requirements.json` from the tag, so
it can say "app-only" or "needs your ComfyUI machine" without the notes. The
notes are for the people and agents doing the update. From 0.3.0 the app's
status panel walks people through updating; before it, the badge linked
straight to the release page. So keep a short **How to update** section in the
notes too, before the machine changes: the agent prompt from the README, and
the steps by hand.

Cut a release whenever a tested, user-visible change lands on `main`: a minor
version for features or machine changes, a patch for fixes. Nobody else gets
anything until there is one.

## Known limits

- **Progress is an estimate.** ComfyUI exposes step-level progress over its
  WebSocket only, and Vercel functions cannot proxy a WebSocket upgrade. The bar
  eases toward 95% against the workflow's `estimatedSeconds` and never claims to
  be done. Real progress would need an SSE relay that opens a WS server-side —
  workable, but it inherits the function timeout ceiling, which is why polling
  is the default.
- **History is per device.** It lives in `localStorage`, so it does not follow
  you between desktop and phone. Making it portable would mean real storage
  (Vercel Blob) and a decision about retention.
- **A music track's length is not something you set.** The slider is a ceiling
  and the model ends the song where it decides to, so takes vary between runs of
  the same prompt. [Length is a target](workflows.md#length-is-a-target-and-the-sampler-decides-the-rest)
  covers why and which controls actually move it.
- **The lyricist and the caption director are one API call each.** A music run
  with *Write the lyrics for me* on makes two, and if the host cannot reach the
  API the run fails at that node — on every workflow, unless *Send my prompt as
  written* has taken the rewrite out of the graph, which is the bypass and the
  only one. The lyricist has no such switch: it is already opt-in.

## Agent files

`AGENTS.md` (loaded by `CLAUDE.md`) carries the rules for working in this repo.
Setup is a separate, task-shaped job, so it lives in
[`agent-setup.md`](agent-setup.md), and a `setup` skill points to it from two
places: `.claude/skills/setup/` and `.agents/skills/setup/`. Agents agree on the
`SKILL.md` format but not on where to look for it — Cursor and VS Code read
both, Claude Code reads only the first. The two copies differ only in Claude
Code's `user_invocable` line. Correct the runbook, not the skills; they are
pointers.

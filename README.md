# Soran’t

A web front end for making video and music on **your own ComfyUI**. Type a
prompt, attach a picture or a clip if you like, and your GPU does the rest. The
app runs on Vercel (or your laptop); the models and the rendering stay on your
machine.

[![Watch the Soran’t trailer on YouTube: a 90-second tour of every
workflow](docs/sizzle-reel.jpg)](https://www.youtube.com/watch?v=ncpg6Nl_Q0g)

## Contents

- [What it does](#what-it-does)
- [What you need](#what-you-need)
- [Quick start](#quick-start)
  - [Set it up with a coding agent (recommended)](#set-it-up-with-a-coding-agent-recommended)
  - [Set it up by hand](#set-it-up-by-hand)
- [Updating](#updating)
- [When something goes wrong](#when-something-goes-wrong)
- [Documentation](#documentation)
- [Scripts](#scripts)
- [Known limits](#known-limits)
- [License](#license)

## What it does

Six video workflows on MiniMax H3, each producing a clip with a generated
soundtrack:

- **Text to Video** — a clip from a prompt.
- **Image to Video** — your picture becomes the first frame.
- **Reference to Video** — puts the people or things in your pictures into a new
  scene. Also takes a song, a voice or a clip as a reference, or a finished
  track locked in as the soundtrack.
- **Remix** — rebuilds a clip you already made as a new take.
- **Extend** — carries a clip on from where it stopped.
- **Music video** — a whole song and one idea: the song is cut into scenes on
  its beats, each scene is planned and rendered with the song under it, and
  the scenes are joined.

And **Text to Image**, an H3 still from a prompt.

Plus **Music** (MiniMax Music 3, a song from a description), **Upscale**
(NVIDIA RTX Video Super Resolution: a sharper copy of a finished clip, up to 4K,
in seconds, or SeedVR2 if you have the time) and an **Edit** button on every picture you attach, which changes it by a sentence with
FLUX Kontext.

![Reference to Video: the workflow picker and a reference photo on the left, the
finished clip with its result actions and the generation history on the
right](docs/screenshot.jpg)

A few things make it more than a form over a graph:

- **Your prompt is rewritten for the model.** A language model turns one line
  into the detailed format MiniMax H3 was trained on. You pick which model does
  it — some are free — or switch the rewrite off.
- **Fast by default.** Turbo and SageAttention start on, cutting a run to a few
  minutes on a 24 GB card. Spectrum is there too, off by default.
- **Runs queue and keep going.** Queue several and walk away: they finish on
  your machine even if you close the tab, and the history picks them back up.
  Every result can be replayed, downloaded, rerun, or handed straight to Remix,
  Extend or Upscale.

It is only a front end: no model weights, no database, nothing expensive.

## What you need

| | |
| --- | --- |
| **GPU** | NVIDIA. **24 GB** runs everything at full size (tested, RTX 3090). **16 GB** should work at the default frame size; **12 GB** has been shown to work at small sizes by others. [Details](docs/setup.md#how-much-vram). |
| **System RAM** | **64 GB.** Model weights that do not fit on the card wait in RAM, so the less VRAM you have, the more this matters. |
| **Disk** | **43 GB** for Text to Video alone; **225.7 GB** for every workflow; **337.4 GB** with every optional extra. See below. |
| **ComfyUI** | A recent build — tested on 0.38 — plus six custom node packs. |
| **OS** | Windows or Linux for ComfyUI. Built and tested on Windows, which needs [one registry fix](docs/setup.md#on-windows-raise-the-gpu-timeout-first); others have set it up on Linux. macOS and AMD cards are untested and unlikely to manage the models. |
| **For the app** | Node 20.9+ and pnpm. A free Vercel account to deploy it. To reach your ComfyUI from Vercel, a free DuckDNS name and a router you can forward a port on (Tailscale Funnel works without the router, but is too slow for long videos). An AI Gateway key is optional: the prompt rewrite can run on your own machine instead. |

Disk space by what you want to run — download only what you will use:

| To run | Disk |
| --- | ---: |
| Text to Video, Text to Image, Image to Video, Extend | 43 GB |
| + Reference to Video and Remix (pictures as references) | +21 GB |
| + a song, voice or clip as a reference, Music video, or Remix at 4 steps | +118 GB |
| + Music | +14 GB |
| + Upscale (needs an NVIDIA RTX card) | +0.1 GB |
| + the Edit button | +29 GB |
| **Every workflow** | **225.7 GB** |
| Optional extras (local prompt rewriting, the VHS tape look, SeedVR2 for Upscale) | +111.7 GB |
| **Everything, extras included** | **337.4 GB** |

Each file and where it comes from is listed in the
[setup guide](docs/setup.md#model-files).

## Quick start

There are two ways in. **Use a coding agent if you can**: most of the setup is
installing node packs and downloading models on the ComfyUI machine, and an
agent does that for you and checks each step as it goes.

### Set it up with a coding agent (recommended)

1. **On your ComfyUI machine** — the computer with the GPU, not your laptop —
   clone the repo:

   ```bash
   git clone https://github.com/pwillia7/sorant.git
   cd sorant
   ```

2. **Open your coding agent in that folder** and paste this (in Claude Code,
   `/setup` does the same):

   ```text
   Set up this project on this machine by following docs/agent-setup.md from
   start to finish. This is my ComfyUI machine: install the custom node packs,
   download the models for the workflows I choose, apply any fixes this OS
   needs, lock ComfyUI with a password, verify a generation, and then help me
   deploy the app to Vercel. Run the test generation yourself and fix what
   fails. Keep the runbook's progress checklist updated as you go, and ask me
   before anything outward-facing or system-wide. Keep a list of anything that
   went wrong, and at the end offer to file it as a setup report on the
   project's GitHub.
   ```

3. **Answer its questions.** It asks which workflows you want and whether you
   are deploying, then installs the node packs, downloads the models, applies
   the Windows GPU fixes, runs a test generation and fixes what fails, makes
   ComfyUI reachable and deploys. You only step in for what has to be yours:
   choosing the ComfyUI password, signing in to Vercel and DuckDNS (and
   Hugging Face, for the Edit button), forwarding a port on your router, and
   choosing where prompts are rewritten: on your own machine with no account,
   or with an AI Gateway key.
   At the end it offers to send a setup report to the project if anything went
   wrong; that's up to you.

It works from [`docs/agent-setup.md`](docs/agent-setup.md), a runbook written
for agents, and most agents find it on their own:

| Agent | How it finds the runbook |
| --- | --- |
| [Claude Code](https://claude.com/claude-code) | `/setup`, or through `CLAUDE.md` |
| Cursor, VS Code / Copilot | the `setup` skill, or `AGENTS.md` |
| Codex, Jules, Zed, Amp… | `AGENTS.md` |
| Anything else | tell it to follow `docs/agent-setup.md` |

### Set it up by hand

Prefer to do it yourself? Follow the [setup guide](docs/setup.md), in order —
most failed setups skipped a step. In short:

1. **[Get ComfyUI ready](docs/setup.md#1-get-comfyui-ready)** — six node packs,
   the model files you want (`pnpm install`, then `pnpm models:download`), a password,
   and a choice of where prompts are rewritten: on that machine, or with an AI
   Gateway key.
2. **[Make ComfyUI reachable](docs/setup.md#2-make-comfyui-reachable)** — only
   if you are deploying. A DuckDNS name with Caddy for HTTPS; Tailscale Funnel
   if you cannot forward a port.
3. **[Run it locally](docs/setup.md#3-run-it-locally)**:

   ```bash
   pnpm install
   cp .env.example .env.local    # set COMFY_URL, COMFY_API_TOKEN, APP_ACCESS_TOKEN
   pnpm check:nodes              # asks your ComfyUI what is missing
   pnpm dev                      # http://localhost:3000
   ```

4. **[Deploy to Vercel](docs/setup.md#4-deploy-to-vercel)**, once one local
   generation has worked.

## Updating

The app checks for a new release each time you open it. When there is one, an
**Update** badge appears in the header and the status pill gets a blue dot;
click either for step-by-step instructions. Updating means redeploying your
copy of the app, and sometimes updating your ComfyUI machine first.

**With a coding agent (easiest).** Open Claude Code, Codex, Cursor or another
coding agent in the folder you cloned Soran’t into, and paste this (in Claude
Code, `/update` does the same):

```text
Update Soran't to the latest release by following the "Updating an existing
install" section of docs/agent-setup.md. Work out first whether it needs
changes on my ComfyUI machine, and ask me before restarting ComfyUI or
deploying.
```

Most releases change only the app, and those can be deployed from any machine
with a clone. Some also need something on the ComfyUI machine, such as a new
node pack, a pack update or a model file. Run those on the ComfyUI machine. The
agent tells the two apart from `machine-requirements.json` and won't deploy the
app before your ComfyUI machine has what the new version needs. The notice says
which kind an update is, and the workflow cards say if your ComfyUI is missing
anything.

**By hand:**

1. In your Soran’t folder: `git pull`, then `pnpm install`.
2. If the release notes list **ComfyUI machine changes**, make them on that
   machine: update ComfyUI, install or update the node packs they name, and
   `pnpm models:download` for new models. Restart ComfyUI, then run
   `pnpm check:nodes` until it reports nothing missing.
3. Deploy. If Vercel builds from your GitHub fork, press **Sync fork** on the
   fork's GitHub page and Vercel deploys it. Otherwise run
   `vercel deploy --prod` in the folder.
4. Reload the app. The notice goes away once the new version is live.

## When something goes wrong

Run `pnpm check:nodes` first — it names every missing pack, model file and key.
The usual suspects:

| Symptom | Likely cause |
| --- | --- |
| Pill reads **Offline** | Wrong `COMFY_URL`, or ComfyUI is not running |
| Pill reads **Auth failed** | `COMFY_API_TOKEN` — usually the [`$` escaping](docs/setup.md#lock-comfyui-with-comfyui-login) |
| Works locally, fails deployed | `COMFY_URL` still points at `localhost` |
| Fails at the rewrite step | No key on the ComfyUI machine, or the model refused — pick another |
| The Windows machine restarts mid-run | The [GPU timeout](docs/setup.md#on-windows-raise-the-gpu-timeout-first) |

The [full troubleshooting table](docs/setup.md#troubleshooting) has the rest.

## Documentation

| Guide | Read it when |
| --- | --- |
| [Setup guide](docs/setup.md) | you are installing it |
| [The workflows](docs/workflows.md) | you want to know what a workflow does with your inputs |
| [The prompt rewrite](docs/prompt-rewrite.md) | a run is refused, or you are choosing a rewrite model |
| [Turbo, SageAttention, Spectrum and the style switches](docs/modes.md) | a switch does something unexpected |
| [Working on Soran’t](docs/development.md) | you are changing the code or adding a workflow |
| [Agent runbook](docs/agent-setup.md) | you are an agent setting this up |

## Scripts

| Command | |
| --- | --- |
| `pnpm dev` | Dev server |
| `pnpm build` | Production build (runs `sync:models` first) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm models:download` | Download the model files for the workflows you choose into a ComfyUI install. Run with `--comfy <folder>` to see sizes first. |
| `pnpm check:nodes` | Ask your ComfyUI for every pack, model and key the app needs. Needs `COMFY_URL`. |
| `pnpm check:workflows` | Check every workflow definition against its own graph. Needs nothing but this repo. |
| `pnpm sync:models` | Rebuild the rewrite-model list from the AI Gateway's live catalog. |
| `pnpm smoke` | Run one short Text to Video through the app and wait for it — the end-to-end check that a setup works. `--director local` for the on-machine rewrite, `--url` for a deployment. |
| `pnpm requirements:write` | Rewrite `machine-requirements.json`, what this version needs from the ComfyUI machine. Run after changing a workflow. |

## Known limits

- **Progress is an estimate.** ComfyUI reports step progress only over a
  WebSocket, which a Vercel function cannot proxy, so the bar is timed against
  what past runs took.
- **History is per device.** It lives in the browser, so it does not follow you
  from desktop to phone.
- **A song's length is a ceiling, not a setting.** The model decides where it
  ends. See [Music](docs/workflows.md#music).

More detail in [Working on Soran’t](docs/development.md#known-limits).

## License

MIT — see [LICENSE](LICENSE). The model weights and custom node packs the
workflows use carry their own licences; check those before redistributing
anything made with them.

If this saved you an afternoon, you can
[buy me a coffee](https://buymeacoffee.com/reticulated). ☕

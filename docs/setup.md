# Setting up Soran’t

[← Back to the README](../README.md)

Four steps, in order. Most failed setups skipped ahead, so finish each one
before starting the next. Using a coding agent? Run it **on the ComfyUI
machine** and point it at [`agent-setup.md`](agent-setup.md) — it does the
installing and downloading itself, and asks you only for passwords and keys.

## Contents

- [1. Get ComfyUI ready](#1-get-comfyui-ready)
  - [How much VRAM](#how-much-vram)
  - [Custom node packs](#custom-node-packs)
  - [Where prompts are rewritten](#where-prompts-are-rewritten)
  - [Model files](#model-files)
  - [On Windows, raise the GPU timeout first](#on-windows-raise-the-gpu-timeout-first)
- [2. Make ComfyUI reachable](#2-make-comfyui-reachable)
  - [HTTPS on your own connection (recommended)](#https-on-your-own-connection-recommended)
  - [Tailscale Funnel (when you cannot forward a port)](#tailscale-funnel-when-you-cannot-forward-a-port)
- [3. Run it locally](#3-run-it-locally)
  - [Environment variables](#environment-variables)
  - [Lock ComfyUI with ComfyUI-Login](#lock-comfyui-with-comfyui-login)
  - [Check it before you generate](#check-it-before-you-generate)
- [4. Deploy to Vercel](#4-deploy-to-vercel)
  - [Deploying from GitHub instead](#deploying-from-github-instead)
- [5. Updating](#5-updating)
- [Troubleshooting](#troubleshooting)
- [Security, in short](#security-in-short)
- [How auth failures surface](#how-auth-failures-surface)

---

## 1. Get ComfyUI ready

This is the part that takes effort; the app itself is a few minutes.

You need a **recent ComfyUI**. MiniMax H3, SeedVR2, FLUX Kontext and the newer
video nodes are all built in, but only on a new enough build — 0.38 is what
this was tested on. If the checker later reports a built-in class such as
`MiniMaxH3ImageToVideo` or `CreateVideo` as missing, update ComfyUI rather than
hunting for a pack.

### How much VRAM

The models are bigger than most cards — the H3 video model alone is 21 GB, its
text encoder another 16 GB — and that is fine. ComfyUI's **Dynamic VRAM**
(NVIDIA, Windows and Linux, on by default in recent builds) keeps the weights in
system RAM and moves each layer onto the card as it runs. So VRAM does not
decide *whether* a model loads. It decides how fast a run goes, and how large a
frame and how long a clip fit before a run fails out of memory — the working
memory for the video itself has to be on the card.

| VRAM | What to expect |
| --- | --- |
| **24 GB** | Everything, up to the app's limits — 1 MP frames, 20-second clips. Tested here on an RTX 3090. |
| **16 GB** | Should run every workflow at the default **Frame size** (0.5 MP). Slower than 24 GB, since more of each model streams from RAM. Untested here. If a run fails out of memory, lower **Frame size** or **Duration** first. |
| **12 GB** | Two RTX 3060 reports: 864×480 for 5 seconds with Turbo in about 4.5 minutes, and on Linux the default 544×960 for 5 seconds in about 14 minutes with the local director. The second needed Dynamic VRAM off and no `--lowvram` — see [Troubleshooting](#troubleshooting). Keep to the default frame size or below, and short clips; the gateway rewrite is the easier choice. |
| **Under 12 GB** | Not recommended. |

What helps on a smaller card:

- **64 GB of system RAM.** With less VRAM, more of every model lives in RAM.
  32 GB will push weights out to disk, which is far slower.
- **Keep Turbo on.** Four to eight steps instead of twenty is the biggest time
  saving there is, and it changes nothing about memory.
- **Mind the bf16 pair.** A Reference to Video run with a song, voice or clip
  attached, or Remix at 4 steps, loads 118 GB of weights. That cannot sit in
  64 GB of RAM, so part of it streams from disk on any card. A fast NVMe drive
  matters there.
- **Upscale** needs under 2 GB with its default RTX Video; SeedVR2's 3B needs
  less than its 7B.
- **Music, both upscales and the Edit button are much smaller** than the H3
  workflows, and should be comfortable on 16 GB.

Dynamic VRAM is NVIDIA-only and not available under WSL. AMD and Apple cards
fall back to ComfyUI's older loading, which is much less forgiving of models
larger than the card, and are untested with this app.

### Custom node packs

Six packs. All but the first install from ComfyUI Manager by name.

| Pack | Needed by |
| --- | --- |
| [comfyui-vercel-ai-gateway](https://github.com/pwillia7/comfyui-vercel-ai-gateway) — Manager → **Install via Git URL** | every workflow that rewrites a prompt: all the H3 ones, Music video's planner, and Music |
| [ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | Remix, Extend, and the SageAttention switch |
| [ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | anything that reads a clip: Remix, Extend, a reference clip, Upscale |
| [ComfyUI_Nvidia_VFX_Nodes](https://github.com/Comfy-Org/ComfyUI_Nvidia_VFX_Nodes) — Manager: "ComfyUI Nvidia VFX Nodes" | Upscale |
| [ComfyUI-MiniMax-H3-Turbo](https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo) — Manager: "MiniMax-H3 Turbo" | the Turbo switch, and any run at 4 steps |
| [ComfyUI-Spectrum-MiniMax-H3](https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3) | the Spectrum switch |

Restart ComfyUI after installing. Three things in that table are easy to miss:

- **Turbo and SageAttention start switched on.** That is how the graphs are
  meant to run, but it means a first video run needs their packs. If one is
  genuinely unavailable, turn its switch off in the settings panel. Spectrum
  starts off, so its pack only matters once you turn that switch on.
- **SageAttention also needs a Python package.** The node patches in a kernel
  rather than shipping one, so install `sageattention` into ComfyUI's own Python
  environment. This is the one requirement the checker cannot see: it will call
  the node present and the run will still fail with the switch on.
- **The turbo pack is needed at 4 steps even with Turbo off**, because the
  graphs swap its sampler in at that step count.
- **Nvidia VFX needs an RTX card, a CUDA 13 PyTorch, and NVIDIA's package
  index.** Its `nvidia-vfx` dependency is not really on PyPI, so if the Manager's
  install leaves the node missing, run
  `python -m pip install nvidia-vfx --extra-index-url https://pypi.nvidia.com`
  with ComfyUI's Python. Without it, choose SeedVR2 in Upscale's settings.

Music needs only the gateway pack. Upscale needs VideoHelperSuite and Nvidia
VFX (or only VideoHelperSuite with SeedVR2). Edit needs none.

### Where prompts are rewritten

Every workflow that generates runs your prompt through a language model first,
which turns one line into the detailed format MiniMax H3 was trained on. You
choose where that happens, from the **Gateway** button in the app's header, and
you can switch at any time:

- **On your ComfyUI machine — no account needed.** An uncensored Gemma runs
  through ComfyUI's built-in `TextGenerate` node: no key, nothing refused, about
  20 seconds slower a run. It needs one more 12 GB file
  (`pnpm models:download --comfy <ComfyUI folder> --extras local-director`).
  Then open the **Gateway** button and set *Where is the prompt rewritten?* to
  **This ComfyUI machine**. The choice is remembered per browser, so set it once
  on each device. The easiest way to start.
- **On the Vercel AI Gateway — a key.** Hosted models: faster, each with a
  content policy. Create a key at
  [vercel.com/dashboard](https://vercel.com/dashboard) → **AI Gateway** → **API
  Keys**. Every Vercel team gets $5 of credit a month; the model picker marks
  which models are free.

  The call is made by the gateway pack on the ComfyUI machine, so **the key
  lives there, not in this app**. Give it to the machine one of two ways:

  - **From the app** — the key button in the header. The key goes through to
    `custom_nodes/comfyui-vercel-ai-gateway/config.json` on the ComfyUI
    machine. This app never stores it and cannot read it back. Easiest when
    ComfyUI is on a machine you are not sitting at.
  - **From the environment**, which wins over the file. Set it in the same
    shell that launches ComfyUI — a different terminal does nothing:

    ```bash
    export AI_GATEWAY_API_KEY=vck_...     # macOS / Linux
    python main.py
    ```

    ```powershell
    $env:AI_GATEWAY_API_KEY = "vck_..."   # Windows PowerShell
    python main.py
    ```

    Under systemd or another service manager, use its own mechanism
    (`Environment=` in the unit file).

  The key is deliberately never written into a workflow: ComfyUI stamps the
  queued workflow into the metadata of every file it saves, so it would travel
  inside every video you share.

**Neither?** Each workflow has a **Send my prompt as written** switch that skips
the rewrite. It works, but the rewrite is most of what turns a one-line prompt
into a usable video — see [the prompt rewrite](prompt-rewrite.md).

### Model files

The easy way is the download script, run on the ComfyUI machine from this repo
(after `pnpm install`):

```bash
pnpm models:download --comfy <your ComfyUI folder>                         # what each workflow needs, and what you have
pnpm models:download --comfy <your ComfyUI folder> --workflows minimax-h3  # Text to Video's five files
pnpm models:download --comfy <your ComfyUI folder> --workflows all
```

It checks free space first, skips files you already have — in this install,
in any folder your `extra_model_paths.yaml` adds, or under another name, which
it hard-links rather than copying — resumes interrupted downloads, and checks
every file's size. If you have a file with the right name but a different size,
it stops without downloading and asks you: `--replace <file>` to get the
version these workflows use, or `--skip <file>` to keep yours. The FLUX Kontext model for the Edit
button is gated: accept its licence on Hugging Face, then set `HF_TOKEN` to a
read token from that account. The tables below say what each file is for.

Download only what you will use. **Text to Video alone needs the five files in
the first block**, about 43 GB. The filenames must match exactly, because they
are values inside the graphs rather than choices in the UI.

| File | Folder under `models/` | Size | Needed by |
| --- | --- | ---: | --- |
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | `diffusion_models/` | 21.0 GB | Text to Video, Text to Image, Image to Video, Extend |
| `qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors` | `text_encoders/` | 15.7 GB | every H3 workflow |
| `minimax_h3_video_vae_fp16.safetensors` | `vae/` | 5.2 GB | every H3 workflow |
| `minimax_h3_audio_vae_fp32.safetensors` | `vae/` | 0.6 GB | every H3 video workflow (not Text to Image) |
| `minimax_h3_turbo_v4_step600_ema.safetensors` | `loras/` | 0.8 GB | the Turbo switch (on by default) |
| | | | |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | `diffusion_models/` | 21.0 GB | Reference to Video, Remix, Music video |
| `minimax_h3_ref2va_bf16.safetensors` | `diffusion_models/` | 66.3 GB | Reference to Video with a soundtrack, voice or clip attached; Music video; Remix at 4 steps |
| `qwen3vl_32b_minimax_h3_bf16.safetensors` | `text_encoders/` | 51.5 GB | the same runs as the file above |
| | | | |
| `minimax_music3_dit_fp16.safetensors` | `diffusion_models/` | 4.9 GB | Music |
| `minimax_music3_text_encoder_pruned_int8_convrot.safetensors` | `text_encoders/` | 9.2 GB | Music |
| `minimax_music3_dav.safetensors` | `vae/` | 0.2 GB | Music |
| | | | |
| `rife_v4.26.safetensors` | `frame_interpolation/` | <0.1 GB | Upscale's **Frame rate: Double it** |
| | | | |
| `flux1-kontext-dev.safetensors` | `diffusion_models/` | 23.8 GB | the Edit button |
| `clip_l.safetensors` | `text_encoders/` | 0.2 GB | the Edit button |
| `t5xxl_fp8_e4m3fn.safetensors` | `text_encoders/` | 4.9 GB | the Edit button |
| `ae.safetensors` | `vae/` | 0.3 GB | the Edit button |

Optional — nothing fails without these until you choose them:

| File | Folder under `models/` | Size | For |
| --- | --- | ---: | --- |
| `gemma4_12b_uncensored_heretic_int8_convrot.safetensors` | `text_encoders/` | 12.1 GB | rewriting prompts on the ComfyUI machine |
| `seedvr2_7b_sharp_int8_convrot.safetensors` | `diffusion_models/` | 8.3 GB | Upscale's **SeedVR2 7B** (`--extras seedvr2`) |
| `seedvr2_ema_vae_fp16.safetensors` | `vae/` | 0.5 GB | either SeedVR2 choice |
| `seedvr2_3b_int8_convrot.safetensors` | `diffusion_models/` | 3.5 GB | Upscale's **SeedVR2 3B** (`--extras upscale-3b`) |
| `film_net_fp16.safetensors` | `frame_interpolation/` | 0.1 GB | FILM interpolation, on either upscale |
| `vh5tape-comfyui.safetensors` | `loras/` | 0.1 GB | the **VHS tape** look ([source](https://huggingface.co/KennethFal/vh5tape-vhs-lora-minimax-h3)) |
| `minimax_h3_fl2va_bf16.safetensors` | `diffusion_models/` | 66.3 GB | what VHS tape runs on (a LoRA cannot use the int8 base) |
| `minimax_h3_fl2va_pruned_fp8_scaled.safetensors` | `diffusion_models/` | 21.0 GB | VHS tape on **Lighter base**, instead of the bf16 |

Where to get them:

| Files | From |
| --- | --- |
| MiniMax H3 | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3), and ComfyUI's [H3 tutorial](https://docs.comfy.org/tutorials/video/minimax/minimax-h3) |
| Turbo LoRA | [larryvrh/MiniMax-H3-Turbo-Lora](https://huggingface.co/larryvrh/MiniMax-H3-Turbo-Lora) |
| Music 3 | [Comfy-Org/MiniMax-Music-3](https://huggingface.co/Comfy-Org/MiniMax-Music-3) |
| SeedVR2 | [Comfy-Org/SeedVR2](https://huggingface.co/Comfy-Org/SeedVR2) |
| RIFE / FILM | [Comfy-Org/frame_interpolation](https://huggingface.co/Comfy-Org/frame_interpolation) |
| FLUX Kontext | ComfyUI's [Kontext tutorial](https://docs.comfy.org/tutorials/flux/flux-1-kontext-dev). The diffusion model is gated: accept its licence on Hugging Face first |
| Local rewrite model | [radiatingreverberations/Gemma-4-12B-It-Uncensored-Heretic-INT8-ConvRot-ComfyUI](https://huggingface.co/radiatingreverberations/Gemma-4-12B-It-Uncensored-Heretic-INT8-ConvRot-ComfyUI) |

**Is your copy named differently?** The download script finds it by size and
links it under the expected name, so there is nothing to rename or edit. To use
a *different* build — the low-VRAM int8 Music 3 DiT, say — change `unet_name`
in the matching `src/lib/workflows/*.ts` file, and expect to redo it after an
update.

**Why two `ref2va` checkpoints?** Reference to Video normally runs on the int8
model, but the int8 build fails on a soundtrack, voice or clip reference, so
attaching one switches to the bf16 model and text encoder — 118 GB more.
Remix makes the same switch at 4 steps. If disk is tight, skip those two files,
use pictures only as references, and keep Remix above 4 steps.

### On Windows, raise the GPU timeout first

MiniMax H3 runs single GPU operations long enough to cross Windows' two-second
GPU timeout (TDR). When the driver reset works, ComfyUI dies. When it does not,
the whole machine blue-screens and restarts with nothing in the log. On a 3090
that was about a third of runs.

In an Administrator prompt, then reboot:

```
reg add "HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" /v TdrDelay /t REG_DWORD /d 60 /f
reg add "HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" /v TdrDdiDelay /t REG_DWORD /d 60 /f
```

Also add `--vram-headroom 3` to ComfyUI's launch line. It stops dynamic VRAM
paging into a full card, a separate Windows failure, at no cost in speed. Leave
it off on Linux: a full card there is an out-of-memory error, not a stall, so
the flag would only hold back 3 GB.

---

## 2. Make ComfyUI reachable

**Running the app on the same machine or network as ComfyUI?** Use
`http://localhost:8188` (or its LAN address) and skip to
[step 3](#3-run-it-locally).

**Deploying to Vercel?** Then ComfyUI must be reachable *from Vercel's
servers*, which are not on your network — `localhost` and `192.168.x.x` cannot
work. This is the most common deployment failure. Two ways, best first.

### HTTPS on your own connection (recommended)

A free [DuckDNS](https://www.duckdns.org) name that follows your home IP,
[Caddy](https://caddyserver.com) on the ComfyUI machine for HTTPS with a free
Let's Encrypt certificate, and one router port forward. Nothing sits between
Vercel and your machine, so a 500 MB 4K upscale downloads as fast as your
upload allows — which is what rules Funnel out for music videos and upscales
(see below). It needs a router you can forward a port on, and a real public
IP: if the WAN address on your router's status page differs from what
<https://ifconfig.me> shows, you are behind carrier-grade NAT and a forward
cannot work — use Funnel.

1. Note the port ComfyUI listens on **locally** — `8188` unless you changed it.
2. At DuckDNS, sign in and add a name. The **current ip** it fills in is the
   one your *browser* is on: change it to the ComfyUI machine's public IP, or
   leave it to the updater in step 3. Keep the token private.
3. Keep the name current from the ComfyUI machine — DuckDNS records the address
   each update comes from. Run every five minutes and at startup (Task
   Scheduler on Windows, cron elsewhere):

   ```shell
   curl "https://www.duckdns.org/update?domains=<your-name>&token=<token>&ip="
   ```

   It answers `OK`. Keep the token in a file only the machine's admins can
   read, not in the task's command line.
4. Install Caddy and give it this `Caddyfile`:

   ```caddyfile
   {
   	auto_https disable_redirects
   }

   your-name.duckdns.org {
   	tls {
   		issuer acme {
   			disable_http_challenge
   		}
   	}
   	reverse_proxy 127.0.0.1:8188 {
   		flush_interval -1
   	}
   }
   ```

   Only 443 is forwarded, so Caddy proves the name over 443 itself and never
   needs port 80. If something else already listens on 443 on this machine —
   Tailscale Serve holds it on the tailnet address — add
   `bind <this machine's LAN IP>` inside the site block.
5. Run Caddy as a service that starts with the machine, and let 443 through
   the firewall. On Windows, from an admin PowerShell:

   ```powershell
   New-Service -Name caddy -StartupType Automatic `
     -BinaryPathName '"C:\Program Files\Caddy\caddy.exe" run --config "C:\ProgramData\Caddy\Caddyfile" --adapter caddyfile'
   New-NetFirewallRule -DisplayName Caddy -Direction Inbound -Action Allow `
     -Protocol TCP -LocalPort 443 -Program 'C:\Program Files\Caddy\caddy.exe'
   Start-Service caddy
   ```

   Not `sc.exe create`: Windows PowerShell breaks its quoting, and it fails
   without saying so. On Linux, the distribution's `caddy` package runs it.
6. On the router: forward **TCP 443** to the ComfyUI machine's LAN IP, port
   443, and reserve that IP for it so it cannot change.
7. `https://your-name.duckdns.org` is your `COMFY_URL`. It answers `401`
   without the token — ComfyUI-Login — and `200` with it. Already deployed?
   `vercel env rm COMFY_URL production`, `vercel env add COMFY_URL production`,
   and redeploy.
8. Close any other port forward pointing at ComfyUI, and leave ComfyUI without
   `--listen`: Caddy reaches it on `127.0.0.1`.

> **ComfyUI is now on the open internet**, behind HTTPS.
> [ComfyUI-Login](#lock-comfyui-with-comfyui-login) is what keeps strangers off
> your GPU, so it is mandatory. A static IP from your ISP changes nothing here:
> a certificate needs a name, so point a DuckDNS name at it anyway.

Do not forward straight to ComfyUI's port over plain HTTP: the token and your
prompts would cross the internet unencrypted, and the app shows an open
padlock for it.

### Tailscale Funnel (when you cannot forward a port)

Real HTTPS with no router changes — but **Funnel's bandwidth is capped**.
Tailscale relays all Funnel traffic through its own servers, and in practice
that is around 150–400 KB/s. Generated clips load, slowly; a joined music video
or a 4K upscale (100–500 MB) cannot finish within the five minutes a Vercel
function is allowed, and the player sits on a grey box for ever. On the
ComfyUI machine:

1. Note the port ComfyUI listens on **locally** — `8188` unless you changed it.
2. Install [Tailscale](https://tailscale.com) and sign in.
3. In the admin console → **DNS**, enable **MagicDNS** and **HTTPS
   Certificates**. Funnel issues no certificate without both.
4. In the admin console → **Access Controls**, allow Funnel:

   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```

5. Start it. `--bg` keeps it running across reboots, and Funnel allows only
   public ports `443`, `8443` and `10000`:

   ```shell
   tailscale funnel --bg --https=443 localhost:8188
   ```

6. `tailscale funnel status` prints the public address, something like
   `https://your-box.your-tailnet.ts.net`. That is your `COMFY_URL`.
7. Check it took: `/api/health` should report `"secure": true`.

To undo: `tailscale funnel --https=443 localhost:8188 off`.

> **Funnel is public.** That is the point — Vercel is not on your tailnet — so
> ComfyUI-Login is what keeps strangers off your GPU. Tailscale *Serve* is the
> private version, and Vercel cannot reach it.

---

## 3. Run it locally

You need Node 20.9+ and pnpm (`npm i -g pnpm`). Running the app on the ComfyUI
machine itself is simplest — it is also where `pnpm models:download` and
`pnpm check:nodes` are most useful.

```bash
pnpm install
cp .env.example .env.local
```

### Environment variables

Fill in `.env.local`:

| Variable | |
| --- | --- |
| `COMFY_URL` | **Required.** ComfyUI's address, no trailing slash. `http://127.0.0.1:8188` when the app runs on the ComfyUI machine; the public address from step 2 on Vercel. |
| `COMFY_API_TOKEN` | The ComfyUI-Login token — see below, and mind the `$` escaping. |
| `APP_ACCESS_TOKEN` | **The app's password** — what you type at the deployed app's gate. There is no default: make one with `openssl rand -hex 32` (or, on Windows, `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`) and keep it in a password manager, or replace it with something easier to type. To change it later, change it here and in Vercel's environment variables, then redeploy. Optional locally, **required before deploying**. |
| `GENERATION_TIMEOUT_SECONDS` | How long the UI waits on a run before giving up. Default 1800. |
| `COMFY_BASIC_AUTH` | Optional `user:password`, if ComfyUI sits behind basic auth instead. |
| `COMFY_AUTH_HEADER_NAME` / `_VALUE` | Optional custom auth header, for other proxies. |

### Lock ComfyUI with ComfyUI-Login

If ComfyUI can be reached from the internet, install
[ComfyUI-Login](https://github.com/liusida/ComfyUI-Login), or anyone who finds
the address can queue jobs on your GPU.

**There is no default password — you choose it.** After installing the pack and
restarting ComfyUI, open <http://127.0.0.1:8188> on that machine. The first
visit asks you to pick a username and password; that is what you will use to
open ComfyUI's own web page from then on. Do this straight away, and before
making ComfyUI reachable: until a password is set the lock is not on, and
whoever reaches the page first gets to choose it.

The app does not use the password itself but a token made from it: the first
line of `login/PASSWORD` in your ComfyUI folder, also printed in the ComfyUI
console as `For direct API calls, use token=$2b$...`. That is your
`COMFY_API_TOKEN`.

Forgot the password? Stop ComfyUI, delete `login/PASSWORD`, restart, and choose
a new one. The token changes too, so update it wherever you set it.

**The trap:** that hash starts with `$2b$`, and `.env` files treat `$2b` as a
variable, silently blanking it. In `.env.local`, put a backslash before every
`$`:

```bash
# console shows: $2b$12$AbCdEf...
COMFY_API_TOKEN=\$2b\$12\$AbCdEf...
```

**In the Vercel dashboard or `vercel env add`, do not escape it** — those
values are taken literally. Getting this backwards is the usual cause of "works
locally, fails in production", or the reverse.

### Check it before you generate

```bash
pnpm check:nodes       # asks your ComfyUI for every pack, model file and key the app needs
                       # add --workflows minimax-h3,... if you downloaded only some
pnpm check:workflows   # checks the app's own workflow definitions; needs no ComfyUI
pnpm dev
```

`check:nodes` names the pack behind every missing class and the workflows behind
every missing file, so read its output before downloading anything else. It
also reports whether the gateway key is visible to ComfyUI.

Open <http://localhost:3000>. The status pill in the header should read
**Ready**. Then run one **Text to Video** generation. It needs no upload, and it
proves the models load and the key works, which no check can.

---

## 4. Deploy to Vercel

Only once a local generation has succeeded — deploying something that has
never worked just moves the debugging somewhere harder.

```bash
pnpm i -g vercel
vercel login
vercel link
```

Add the environment variables. **No `$` escaping here:**

```bash
vercel env add COMFY_URL production          # the public address from step 2
vercel env add COMFY_API_TOKEN production
vercel env add APP_ACCESS_TOKEN production
```

Then create a private **Blob store**. Vercel refuses request bodies over
4.5 MB, so uploads larger than 4 MB go from the browser to Blob, are copied to
ComfyUI, and are deleted. Without a store, small uploads work and large ones
fail.

```bash
vercel blob create-store sorant-uploads --access private --yes
vercel deploy --prod
```

`create-store` also rewrites `.env.local` with the project's development
variables — check it afterwards. The upload ceiling is 100 MB, matching
ComfyUI's `--max-upload-size 100`. To raise it, change both that flag and
`LARGE_UPLOAD_MAX_BYTES` in `src/lib/upload-limits.ts`.

Load the deployment, enter your `APP_ACCESS_TOKEN` at the prompt, confirm the
pill reads **Ready**, and generate once.

> **Always set `APP_ACCESS_TOKEN`.** On Vercel's Hobby and Pro plans,
> production deployments are publicly reachable, and this token is the only
> thing between the internet and your GPU.

### Deploying from GitHub instead

Connect the repo to a Vercel project and every push to `main` deploys
production; other branches get preview deployments behind a Vercel login. That
makes a push to `main` a public release. `vercel deploy --prod` still works for
deploying your working copy directly.

If your fork is public, leave **Git Fork Protection** on (Project Settings →
Security). It stops a stranger's pull request from building with your
environment variables — including your ComfyUI token.

---

## 5. Updating

The app's header shows an **Update** notice when a newer release is out.
Hover over it, or open the release notes, to see which kind of update it is:

- **App-only.** Nothing changes on the ComfyUI machine. From any machine with a
  clone: `git pull`, `pnpm install`, `vercel deploy --prod` (run `vercel link`
  first and pick your existing project if that machine has never deployed).
  If `git pull` refuses over `src/lib/workflows/generated/`, a local build
  rewrote it: `git checkout -- src/lib/workflows/generated/` and pull again.
  If you deploy from GitHub instead, use **Sync fork** on your fork.
- **ComfyUI machine changes.** The release notes list them under **ComfyUI
  machine changes**: a node pack to install or update, a model file to
  download, or a newer ComfyUI. Do those on the ComfyUI machine first, restart
  ComfyUI, and run `pnpm check:nodes` until it passes. Only then deploy the
  app. Deploying first is what leaves a workflow failing on a node ComfyUI
  doesn't recognise.

To check which kind an update is yourself, compare the `fingerprint` at the top
of `machine-requirements.json` between the two versions. If it's the same, the
update is app-only. If the ComfyUI machine is missing anything the new version
needs, the workflow cards say so.

A coding agent can do all of this: see [Updating](../README.md#updating) in the
README for the prompt to paste.

## Troubleshooting

`/api/health` is the quickest answer to "is it connected": it reports
`reachable`, `authorized` and `secure` separately.

| Symptom | Look at |
| --- | --- |
| Pill reads **Offline** | `COMFY_URL`; is ComfyUI running; is the port reachable from where the app runs |
| Pill reads **Auth failed** | `COMFY_API_TOKEN`; the `$` escaping; is ComfyUI-Login enabled |
| Works locally, fails deployed | `COMFY_URL` still `localhost`, or the token escaped in Vercel where it should not be |
| A correct token is still rejected | ComfyUI launched with `--enable-cors-header <some-origin>` — drop the flag or set it to `*`. ComfyUI-Login only checks the token when that header matches, and server-side requests send none |
| A run fails naming a node class | `pnpm check:nodes` — a pack is missing |
| Fails at the rewrite: no key | Switch the rewrite to **This ComfyUI machine** from the header's Gateway button, or set a key there — see [where prompts are rewritten](#where-prompts-are-rewritten) |
| First run fails with `tcc.exe … returned non-zero exit status 1` (Windows portable) | The portable Python has no `Include` and `libs` folders, which SageAttention's compiler needs. Copy both from the NuGet `python` package of exactly the same version — the [agent runbook](agent-setup.md#phase-2--custom-node-packs) has the commands. Don't just turn SageAttention off |
| Fails at the rewrite, no clear reason | Usually the model refused. Pick a different **Rewrite model** behind the header's Gateway button and retry |
| Rewrite says the model is not in the list | The gateway retired it. Redeploy — the build runs `pnpm sync:models`. Don't commit the regenerated file in your clone; it blocks the next `git pull` |
| `check:nodes` fails only on models for workflows you skipped | Run it as `pnpm check:nodes --workflows <the ones you downloaded>` |
| 12 GB card on Linux: `illegal memory access`, Xid errors, a ComfyUI that hangs on to its port | Add `--disable-dynamic-vram` to the launch line, and use `--reserve-vram 1.5` rather than `--lowvram` |
| 12 GB card: the local rewrite takes an hour, or fails `Expected a cuda device, but got: cpu` | `--lowvram` put Gemma on the CPU. Drop it, or use the gateway rewrite |
| "The local director is chosen but … is not in" | The Gemma file is not in `models/text_encoders/`, or switch the rewrite back to the gateway |
| Only the **Edit** button fails | One of the four FLUX Kontext files — `pnpm check:nodes` names it |
| Large uploads fail when deployed | No Blob store — see [step 4](#4-deploy-to-vercel) |
| The Windows machine restarts during step 1 | [The GPU timeout](#on-windows-raise-the-gpu-timeout-first). Display event 4101 in the System log confirms it |
| A job shows as **Lost** | ComfyUI restarted and forgot its history |
| A long video sits on a grey box and never plays, short clips load | `COMFY_URL` is a Tailscale Funnel, whose bandwidth cannot carry a file that size within a Vercel function's five minutes. [Use HTTPS on your own connection](#https-on-your-own-connection-recommended) |
| "Contact was lost" | The connection dropped, not the workflow. Check the pill and resubmit — the run may have finished anyway |

---

## Security, in short

- **`APP_ACCESS_TOKEN` protects this app; `COMFY_API_TOKEN` protects ComfyUI.**
  They are independent, and ComfyUI stays reachable directly whatever the app's
  token is.
- **Plain HTTP exposes the ComfyUI token in transit.** Caddy or Funnel fixes
  that. If the token has ever crossed plain HTTP, rotate it.
- **The ComfyUI-Login token never expires.** Treat it as a long-lived secret.

## How auth failures surface

Worth knowing when the pill says **Auth failed** and you are sure the token is
right.

Every call to ComfyUI carries `Authorization: Bearer <COMFY_API_TOKEN>` — a
header rather than ComfyUI-Login's `?token=` form, because the hash contains
characters that need URL escaping and query strings end up in logs.

A refusal from ComfyUI comes back from this app as **502, never 401**. A 401
from this app means *your* `APP_ACCESS_TOKEN` is wrong, and the UI responds by
asking for it again — the wrong reaction to a misconfigured ComfyUI token. Three
refusals are recognised, and all read as **Auth failed** rather than
**Offline**:

| ComfyUI responds | Meaning |
| --- | --- |
| `401` / `403` | token rejected or missing |
| `302 → /login` | redirects are not followed, so this cannot pass for success |
| `200` with HTML | the login page, served instead of JSON |

Some builds of ComfyUI-Login redirect every request to `/login`, even ones
asking for JSON, which is why the redirect case exists.

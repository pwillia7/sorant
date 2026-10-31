# Setting up Soran’t — a runbook for coding agents

Plain markdown, no tool-specific syntax. Any coding agent can read and follow
this; nothing here depends on a particular assistant.

**If you are a human:** [`setup.md`](setup.md) covers the same ground in a form
meant for reading rather than executing. This file is the version an agent
works from.

## What you are doing

You are running **on the person's ComfyUI machine** — the computer with the GPU
— with this repo cloned onto it. Your job is to configure that machine so the
app works against it: install the custom node packs, download the models,
apply the Windows fixes, lock ComfyUI with a password, prove a generation works
by running one yourself, then make ComfyUI reachable and deploy the app to
Vercel. The app itself is the easy part; almost every failed setup is on the
ComfyUI side, which is why you are on it.

**Check that first.** Find ComfyUI on this machine (Phase 0). If the repo was
cloned onto a laptop and ComfyUI is on another computer, stop and say so: the
setup has to run on the ComfyUI machine, so they should clone the repo there and
start you again. If this machine has the GPU but no ComfyUI at all, Phase 0 says
how to install one.

**Updating an install that already works is different:** go to
[Updating](#updating-an-existing-install). It can start on any machine with a
clone, and it decides for itself whether it has to finish on the ComfyUI one.

Work the phases in order. Phase 5 (the password) always comes before Phase 6
(making ComfyUI reachable): a ComfyUI made reachable before its password is set
can be claimed by whoever finds it first.

## Ground rules

- **Do the work.** Install, download, edit config, run checks. Do not hand the
  person a list of things you could have done yourself.
- **Be prescriptive.** Assume the person is not technical. Where this runbook
  gives a default — a port, a name, a folder, an order — use it and say in one
  line what you did; do not offer a menu of options. Ask only what is theirs to
  decide: which workflows, local or deployed, their accounts and passwords,
  disk space and money, and anything system-wide.
- **Run the checks and the test generation yourself.** `pnpm check:nodes` and
  `pnpm smoke` tell you what is wrong in words you can act on. When something
  fails, read the error, fix it, and run it again before involving the person.
  Bring them in for what only they can do, not to report an error you could
  have fixed.
- **Ask before** anything that changes the machine beyond ComfyUI's own folder
  and this repo (installing system software, the registry, PATH), anything that
  restarts ComfyUI while it may be rendering, and anything outward-facing:
  a system service, a firewall rule, a router port forward, Tailscale Funnel,
  Vercel projects, environment variables, deploys, filing an issue.
- **Never handle their secrets in chat.** The ComfyUI password, the AI Gateway
  key and the Hugging Face token are typed by the person — into a browser, the
  app, or their own shell. You may read the ComfyUI token from its file and
  write it into `.env.local` or Vercel, but never print it.
- **Keep a running list of what went wrong.** Every error, every place this
  runbook was wrong or silent, every workaround. Phase 9 offers to send it to
  the project so the next setup goes better.
- **Tick gates from output, not from what you are told.** Copy this checklist
  into your reply and keep it current:

```
Setup progress:
- [ ] 0 Survey          ComfyUI found (or installed); GPU, RAM, disk, Node,
                        version known; workflows chosen; local or deploy
                        decided; accounts started
- [ ] 1 App             gate: `pnpm install` succeeds
- [ ] 2 Node packs      gate: no IMPORT FAILED in the startup log, Python
                        headers present (Windows portable)
- [ ] 3 Models          gate: `pnpm models:download` exits 0 for the chosen set
- [ ] 4 Windows         TDR values set, reboot done (Windows only)
- [ ] 5 Password        gate: ComfyUI-Login on, password set, token in .env.local
- [ ] 6 Reachability    (deploy only, ask first) gate: the public HTTPS
                        address answers 401 bare, 200 with the token
- [ ] 7 Local verify    gate: `pnpm check:nodes --workflows <their set>` exits 0,
                        a prompt rewrite is
                        set up, `pnpm smoke` passes
- [ ] 8 Deploy          (ask first) gate: `pnpm smoke --url <deployment>` passes
- [ ] 9 Report          (optional, ask first) issue filed or declined
```

**On Windows**, a few shell habits save time:

- In PowerShell, quote comma-separated lists (`'a,b'`): unquoted, `a,b` is an
  array.
- Write files with LF line endings (or let the scripts read CRLF — they do now).
- The Vercel CLI prints hints on stderr, which PowerShell turns into a
  `NativeCommandError` even when the command worked. Judge Vercel commands by
  their output, not their exit code.
- `nslookup` and `Resolve-DnsName` are answered by Tailscale locally on a
  machine running it, even when you name a public server. See Phase 6.

## Phase 0 — Survey the machine

Find out, by looking rather than asking where you can:

- **Every ComfyUI install on this machine.** Look for a `main.py` with a
  `custom_nodes/` folder beside it: a `ComfyUI_windows_portable\ComfyUI` folder,
  a git clone, or the ComfyUI Desktop app's data folder. For each one, note its
  version (`comfyui_version.py`), its Python (portable: `python_embeded\python.exe`
  next to the `ComfyUI` folder; a clone: its `venv`/`.venv`; Desktop: the `.venv`
  in its data folder), the port in its launch script (`--port`, default 8188),
  whether `login/PASSWORD` exists, its `extra_model_paths.yaml`, and whether its
  `models` folders are links into another install (`Get-ChildItem models |
  select Name,LinkType,Target` on Windows, `ls -l` elsewhere). One install: use
  it. Several: say what each is in a line and ask which to set up.
- **Its launch script** (`run_nvidia_gpu.bat`, a shell script, a systemd unit) —
  you will edit it in Phase 2.
- **Whether it is running**, and its version: `curl -s
  http://127.0.0.1:<its port>/system_stats` reports the ComfyUI version, Python,
  PyTorch, OS, RAM and GPU. Not running is fine; a ComfyUI with ComfyUI-Login
  already on answers with a redirect to `/login`.
- **GPU and drive**: `nvidia-smi`, and free space on the models drive.
- **Node 20.9+, pnpm and git.** `node -v` below 20.9 needs a newer Node, which is
  system software: ask, then on Windows `winget install OpenJS.NodeJS.LTS` (or,
  with nvm-windows, `nvm install <full version> 64` — not `nvm install 22`,
  which can resolve to an arm64 build — then `nvm use <version>` from an
  Administrator terminal). On Linux, the person's package manager or nvm. Git
  for Windows: `winget install Git.Git`. Then `npm i -g pnpm`.

**No ComfyUI on this machine, but it has the GPU:** offer to install it. On
Windows, the portable build — the latest NVIDIA release from
<https://github.com/comfyanonymous/ComfyUI/releases>, extracted to a folder with
room for the models (a drive with 150 GB or more free if they want everything).
On Linux, `git clone https://github.com/comfyanonymous/ComfyUI`, a venv, and its
`requirements.txt` with the PyTorch build for their CUDA. Run it once to prove it
starts, then carry on.

**Hardware.** Tested on Windows, ComfyUI 0.38 and later, an RTX 3090 (24 GB) and
64 GB of RAM. ComfyUI's Dynamic VRAM (NVIDIA, Windows and Linux, not WSL)
streams weights from RAM, so VRAM limits speed and frame size rather than
whether a model loads: 16 GB should run the default 0.5 MP frame size. 12 GB
works, with more care: two 3060 reports, 864×480 5 s with Turbo in about
4.5 minutes, and on Linux 544×960 5 s in about 14 minutes with the local
director — the latter only after the 12 GB rows in the troubleshooting table. Below 12 GB, AMD or
Apple: say it is unsupported. The full table is in
[`setup.md`](setup.md#how-much-vram).

A ComfyUI older than 0.38 should be updated first — the H3, SeedVR2 and FLUX
Kontext nodes are built in, but only on a recent build, and the local director
needs 0.38's `TextGenerate`. Ask before updating a working install.

**Then ask two things:**

1. **Which workflows they want.** Text to Video, Image to Video and Extend share
   one 43 GB set; Reference to Video and Remix add 21 GB, and 118 GB more for a
   song, voice or clip as a reference; Music 14 GB; Upscale nothing to speak of
   (but an NVIDIA RTX card), or 9 GB more with SeedVR2; the Edit button
   29 GB. Phase 3 checks these against what is already on disk. Recommend
   starting with Text to Video if disk or time is short: a narrower first pass
   that works beats a complete one that takes a day.
2. **Local only, or deployed to Vercel** so they can use it from their phone or
   anywhere. Local only skips Phases 6 and 8.

**Start the accounts now**, so they are ready by the time they are needed and
the person can do them while downloads run. Tell them which apply:

- **Deploying:** a Vercel account (<https://vercel.com/signup>), a DuckDNS
  name (<https://www.duckdns.org>, sign in and add one; the token stays with
  them), and access to their router's port forwarding. Without router access,
  or behind carrier-grade NAT (Phase 6), a Tailscale account instead
  (<https://login.tailscale.com/start>) with **DNS → MagicDNS**, **DNS → HTTPS
  Certificates**, and in **Access Controls**
  `"nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]`.
- **The Edit button:** a Hugging Face account, the FLUX Kontext licence accepted
  at <https://huggingface.co/black-forest-labs/FLUX.1-Kontext-dev>, and a read
  token from <https://huggingface.co/settings/tokens> (Phase 3).
- **Nothing else is required.** The prompt rewrite can run on this machine with
  no account (Phase 7); an AI Gateway key is optional.

## Phase 1 — The app

```bash
pnpm install
```

npm works too if they refuse pnpm — the lockfile is pnpm's, so expect a fresh
resolve and say so.

## Phase 2 — Custom node packs

Clone each into ComfyUI's `custom_nodes/` and install its requirements with
ComfyUI's own Python (`<python> -m pip install -r requirements.txt` — on the
portable build, `python_embeded\python.exe -s -m pip ...`). Skip any already
present; `git pull` updates one. Some packs have no `requirements.txt`.

| Pack | Repository | Needed by |
| --- | --- | --- |
| Vercel AI Gateway | `https://github.com/pwillia7/comfyui-vercel-ai-gateway` | every workflow that rewrites a prompt — all the H3 ones, Music video's planner, and Music |
| KJNodes | `https://github.com/kijai/ComfyUI-KJNodes` | Remix, Extend, the SageAttention switch |
| VideoHelperSuite | `https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite` | Remix, Extend, a reference clip, Upscale |
| Nvidia VFX Nodes | `https://github.com/Comfy-Org/ComfyUI_Nvidia_VFX_Nodes` | Upscale — **see below for its pip install** |
| MiniMax-H3 Turbo | `https://github.com/Larryvrh/ComfyUI-MiniMax-H3-Turbo` | the Turbo switch, and any run at 4 steps |
| Spectrum | `https://github.com/xmarre/ComfyUI-Spectrum-MiniMax-H3` | the Spectrum switch |
| ComfyUI-Login | `https://github.com/liusida/ComfyUI-Login` | locking ComfyUI — **clone it, but read Phase 5 before restarting** |

All but Nvidia VFX are required: Turbo and SageAttention start switched on, so
a video run fails without their packs; Spectrum starts off but `check:nodes`
still asks for its pack, since the switch is offered; and ComfyUI-Login is the
lock. A pack that genuinely will not install can be worked around by turning
its switch off in the app's settings panel — say which.

**Nvidia VFX Nodes is Upscale, and only Upscale.** It needs an NVIDIA RTX card
(20 series or later) and a CUDA 13 PyTorch (`cu130` in `torch.__version__`).
Its one dependency, `nvidia-vfx`, is published only on NVIDIA's own index —
PyPI has a placeholder that fails with `BackendUnavailable` — so install its
requirements with
`<python> -m pip install -r requirements.txt --extra-index-url https://pypi.nvidia.com`.
Wheels exist for Windows and Linux x86-64. Without an RTX card or with an older
PyTorch, skip the pack, download the `seedvr2` extra instead, and tell them:
Upscale's default upscaler will not run, and its SeedVR2 choice does the same
job, much more slowly. Do not upgrade PyTorch for it
without asking.

**SageAttention also needs the `sageattention` Python package** in ComfyUI's
environment; the node patches in a kernel rather than shipping one. Install
`<python> -m pip install sageattention` (on Windows also `triton-windows`, whose
version has to match PyTorch — pip normally resolves it; 3.8 for torch 2.14,
3.7 for 2.13). If it will not install cleanly against their PyTorch, stop there
— do not reinstall PyTorch — and tell them to switch SageAttention off.

**On the Windows portable build, give its Python its headers.** Triton compiles
a small helper against the embedded Python on the first SageAttention run, and
the portable `python_embeded` ships without `Include\` and `libs\`. Without them
`import sageattention` succeeds and the first generation fails with a `tcc.exe
… returned non-zero exit status 1` error. Check for
`python_embeded\Include\Python.h` and `python_embeded\libs\python3XX.lib`; if
either is missing, take both folders from the official NuGet package of
**exactly** the same Python version, which needs no installer:

```powershell
$v = & .\python_embeded\python.exe -c "import platform; print(platform.python_version())"
Invoke-WebRequest "https://www.nuget.org/api/v2/package/python/$v" -OutFile "$env:TEMP\python-$v.zip"
Expand-Archive "$env:TEMP\python-$v.zip" "$env:TEMP\python-$v" -Force
Copy-Item "$env:TEMP\python-$v\tools\include" .\python_embeded\Include -Recurse -Force
Copy-Item "$env:TEMP\python-$v\tools\libs" .\python_embeded\libs -Recurse -Force
```

If NuGet has no package for that exact version, copy the two folders from
another install of the same version, and say so. `pnpm smoke` in Phase 7 is
what proves SageAttention actually works; `check:nodes` only sees the node.

**Edit the launch line once, now, before the restart.** Add
`--max-upload-size 100` (the app's upload ceiling). **Do not add
`--vram-headroom`**, and take it off if it is there: earlier versions of this
runbook recommended `--vram-headroom 3` against a Windows paging stall
(Comfy-Org/ComfyUI#15360) that was never reproduced here, and the restarts it
was added during were Windows' GPU timeout (Phase 2's `TdrDelay`). It is not
free: it holds back the room Qwen 3.8 27B needs, and half that model's
replies then stream weights from system RAM — the same brief in six minutes
instead of forty seconds. `pnpm check:nodes` warns when it is on the launch
line. Do not add `--listen`: Caddy and Funnel connect to localhost, and
`--listen` exposes ComfyUI to the whole network. Do not add
`--enable-cors-header` with a specific origin (see troubleshooting). Keep the
`--port` it has.

**Restart ComfyUI** (ask first if it may be rendering). Start it from its launch
script in a window of its own — on Windows `start "" <script>.bat` — so it keeps
running after your session ends; tell the person that is how to start it after
a reboot. Read the startup log: the gate is no `IMPORT FAILED` line, and every
pack listed under the import times (a long path can wrap onto the next line).
ComfyUI-Login starts locking the server on this restart, so go straight on to
Phase 5's password step if you are doing it now — or leave ComfyUI-Login out of
`custom_nodes/` until Phase 5.

## Phase 3 — Models

```bash
pnpm models:download --comfy <ComfyUI folder>                               # costs and what is present
pnpm models:download --comfy <ComfyUI folder> --workflows minimax-h3,minimax-music3 --dry-run
pnpm models:download --comfy <ComfyUI folder> --workflows minimax-h3,minimax-music3
```

The script counts a file as present wherever ComfyUI would find it: the
install's own `models/`, every folder its `extra_model_paths.yaml` adds, and
any further `--models-dir <path>`. New files go into the install's own
`models/`. `--workflows all` takes everything required; `--extras` adds optional
sets (`local-director`, `local-director-27b`, `vhs-tape`, `vhs-tape-lighter`, `seedvr2`, `upscale-3b`, `film`);
`--skip <file>` leaves one out — the usual one is the bf16 pair,
`minimax_h3_ref2va_bf16.safetensors,qwen3vl_32b_minimax_h3_bf16.safetensors`, if
they will use only pictures as references. Lists take commas or spaces.

**Another ComfyUI on this machine already has the files?** Do not download them
twice. Add that install's models folder to this one's `extra_model_paths.yaml`
— a section with `base_path:` set to it and a line per folder
(`diffusion_models: diffusion_models/`, `text_encoders: text_encoders/`,
`vae: vae/`, `loras: loras/`, and so on) — and run the script again; it reads
the file.

The script works out which files each workflow needs from the graphs
themselves, checks free space before starting, resumes partial downloads, and
verifies each file's size. It exits 0 when everything chosen is in place, so
re-run it until it does. These are tens of gigabytes — hours on a home
connection: run it in the background and carry on with Phase 4.

**The Edit button's FLUX Kontext model is gated.** The person accepts the
licence and creates a token (Phase 0), then sets `HF_TOKEN` in the shell that
runs the script. The script stops and says so if it is missing;
`--skip flux1-kontext-dev.safetensors` downloads the rest.

**Someone who already runs H3 in ComfyUI** usually downloads nothing. A file
already in a models folder under another name, or in a subfolder, is found by
its exact size and hard-linked under the name the graphs use: the same data
under a second name, no copy. A file with the right name but the **wrong size**
is someone's own copy — an older or newer revision — and the script stops
without downloading anything and says where it is. Ask the person: `--replace
<file>` gets the version these workflows were made with (theirs is kept as
`<file>.old` if it is in this install's own folder, and left alone anywhere
else), `--skip <file>` keeps theirs and accepts that the workflow may not run.
Never edit the filenames in the workflow files to match: an update would undo
it.

**The optional sets, and when to offer them:**

- **`local-director`** (12 GB) or **`local-director-27b`** (17 GB) — rewrites
  prompts on this machine through ComfyUI's built-in `TextGenerate`. No
  account and no key. **Offer one by default**: it is the rewrite that needs
  nothing else. Which one depends on the card — see *Choose where prompts are
  rewritten* in Phase 7, and decide it with the person now, so the download
  runs with the rest.
- **`vhs-tape` / `vhs-tape-lighter`** — the VHS tape content LoRA. H3 LoRAs
  break on the int8 *rotated* base the graphs ship on (warped faces, melting
  limbs, no error), so the switch swaps to a non-rotated checkpoint while on:
  bf16 (66 GB) or the fp8 **Lighter base** (21 GB). One of the two, not both.
  Reference to Video and Remix use the `ref2va` bf16 file for it.
- **`seedvr2`** (9 GB), **`upscale-3b`** (4 GB) — Upscale's SeedVR2 choices,
  which invent fine texture where the default only sharpens, and take about a
  hundred times as long. Offer `seedvr2` only if they ask for it, or the
  machine cannot run the Nvidia VFX pack.
- **`film`** — the slower FILM frame interpolation, picked in Upscale's
  controls.

Music 3 also has an `int8_convrot` DiT for short-VRAM cards; using it means
changing `unet_name` in `minimax-music3.ts`.

## Phase 4 — Windows only

**Set the GPU timeout before the first H3 run.** H3 issues single GPU
operations long enough to cross Windows' two-second TDR limit. When the driver
reset succeeds, ComfyUI dies and Display event 4101 is logged; when it fails,
the machine blue-screens and restarts with nothing in the log. On a 3090 it was
about a third of runs. Read the current values first:

```
reg query "HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" /v TdrDelay
reg query "HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" /v TdrDdiDelay
```

Both 60 (`0x3c`): done. Otherwise they need an elevated prompt and a reboot —
ask first, run them if you are elevated, otherwise give the person these two
lines to paste into an Administrator terminal:

```
reg add "HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" /v TdrDelay /t REG_DWORD /d 60 /f
reg add "HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers" /v TdrDdiDelay /t REG_DWORD /d 60 /f
```

**The reboot has to happen before Phase 7's test generation** — that first H3
run is the one most likely to reset the machine. Time it for when the downloads
are done, or before them if there are none, and remind the person to start
ComfyUI from its launch script afterwards.

## Phase 5 — Lock ComfyUI with a password

Do this even for local-only use if the machine is on a shared network, and
always before Phase 6.

**There is no default password.** ComfyUI-Login has none until someone sets
one, and whoever first opens its login page chooses it. Until then it is not a
lock at all: the token it checks against is empty, so a request carrying an
empty `?token=` is let through. Set the password in the same sitting as the
restart that enables it, and always before ComfyUI is reachable from the
internet.

1. With ComfyUI-Login in `custom_nodes/`, restart ComfyUI.
2. Have the person open `http://127.0.0.1:<port>` — give them the exact
   address, with the port from the launch script — in a browser **on this
   machine**. The first visit shows a first-time page: they choose a username
   and password. That password is what they will type to use ComfyUI's own web
   interface from now on. Do not choose it for them.
3. The API token is the bcrypt hash of that password, stored as the **first
   line of `<ComfyUI folder>/login/PASSWORD`** (the console also prints it as
   `For direct API calls, use token=$2b$...`). Read it from the file and write
   it into `.env.local` (Phase 7) — without printing it.

**Forgotten password, or a fresh start:** stop ComfyUI, delete
`login/PASSWORD`, restart, and set a new one. The token changes with it, so
update `.env.local` and Vercel.

**Deploying?** Go to Phase 6 now, then come back to Phase 7. A new public name
or certificate can take a few minutes, and Phase 7 covers the wait.

## Phase 6 — Reachability (deploying only)

A Vercel function is not on their network, so ComfyUI must be reachable from
the internet. Ask before doing this, then do it without further questions.

**Use DuckDNS and Caddy**: HTTPS terminated on this machine, one router port
forward, and nothing between Vercel and ComfyUI. Tailscale Funnel is the
fallback, not the default: its traffic is relayed at around 150–400 KB/s, so a
joined music video or a 4K upscale (100–500 MB) cannot load through a Vercel
function's five minutes, and the player shows a grey box for ever.

**First, can a port be forwarded at all?** Compare the public IP
(`curl -s https://ifconfig.me`) with the WAN address on the router's status
page; the person reads the router. Different means carrier-grade NAT: go to
the Funnel fallback below.

1. **The DuckDNS name** from Phase 0. Its web page fills in the IP of the
   browser that made it, which is often not this machine; the updater fixes
   that on its first run.
2. **The token** is the person's. Write a script that asks for it with
   `Read-Host -AsSecureString` (or `read -s`), saves it to a file only admins
   and SYSTEM (root) can read — on Windows `C:\ProgramData\Sorant\duckdns.token`,
   `icacls <file> /inheritance:r /grant:r SYSTEM:F Administrators:F` — and
   calls the update once, and have the person run it in **their own terminal**
   (`ssh -t` when you work remotely: an agent's shell has no TTY to type into).
   `https://www.duckdns.org/update?domains=<name>&token=<token>&ip=` answers
   `OK`; an empty `ip=` means the address the request came from.
3. **The updater:** a script reading that file and calling the same URL,
   every five minutes and at startup — on Windows a scheduled task as SYSTEM
   (`Register-ScheduledTask` with a `-RepetitionInterval` trigger and an
   `-AtStartup` one), elsewhere cron or a systemd timer.
4. **Caddy**, the release binary from
   <https://github.com/caddyserver/caddy/releases> (on Windows into
   `C:\Program Files\Caddy`), with this `Caddyfile`:

   ```caddyfile
   {
   	auto_https disable_redirects
   }

   <name>.duckdns.org {
   	bind <LAN IP>
   	tls {
   		issuer acme {
   			disable_http_challenge
   		}
   	}
   	reverse_proxy 127.0.0.1:<ComfyUI's port> {
   		flush_interval -1
   	}
   }
   ```

   Only 443 is forwarded, so the certificate is proven over 443
   (TLS-ALPN) and port 80 stays shut. `bind` is needed when something already
   listens on 443 — check `Get-NetTCPConnection -State Listen -LocalPort 443`
   (or `ss -ltnp`); tailscaled holds 443 on the tailnet address whenever
   Tailscale Serve uses it. `caddy validate --config <file> --adapter
   caddyfile` before installing.
5. **The service and the firewall** (Windows, admin):

   ```powershell
   New-Service -Name caddy -DisplayName 'Caddy' -StartupType Automatic `
     -BinaryPathName '"C:\Program Files\Caddy\caddy.exe" run --config "C:\ProgramData\Sorant\Caddyfile" --adapter caddyfile'
   sc.exe failure caddy reset= 86400 actions= restart/5000/restart/5000/restart/5000
   New-NetFirewallRule -DisplayName 'Caddy HTTPS' -Direction Inbound -Action Allow `
     -Protocol TCP -LocalPort 443 -Program 'C:\Program Files\Caddy\caddy.exe'
   Start-Service caddy
   ```

   Not `sc.exe create`: Windows PowerShell mangles the quotes in `binPath=`
   and sc.exe then fails without saying so. In a script under
   `$ErrorActionPreference = 'Stop'`, `caddy validate` logging to stderr is a
   terminating `NativeCommandError` even when it passes — set `Continue`
   around it and check `$LASTEXITCODE`. Linux: the distribution's `caddy`
   package and its systemd unit.
6. **The router**, by the person: forward TCP 443 to this machine's LAN IP,
   port 443; reserve that IP for this machine (a `bind` breaks the day it
   changes); delete any older forward to ComfyUI's own port.
7. **Check it:** `curl -s -o /dev/null -w "%{http_code}\n"
   https://<name>.duckdns.org/system_stats` gives `401`, and `200` with
   `-H "Authorization: Bearer <token>"`. A TLS error in the first minute is
   Caddy still getting its certificate; `Get-Service caddy` and Caddy's log
   say why it is not. `https://<name>.duckdns.org` is the deployed `COMFY_URL`.

If the agent's own permissions will not let it install a service or open a
port, write the scripts, copy them over, and give the person the exact command
to run in their own terminal — with forward slashes in Windows paths, since
their shell eats a backslash before the remote side sees it.

### Fallback: Tailscale Funnel

Only when no port can be forwarded. Tell the person, before setting it up,
that long joined videos and 4K upscales will not load through it.

1. **Install Tailscale** if `tailscale version` fails — on Windows `winget
   install Tailscale.Tailscale` (needs admin; ask), on Linux
   `curl -fsSL https://tailscale.com/install.sh | sh`. Run `tailscale up` and
   give the person the sign-in link it prints.
2. **Check the admin console steps from Phase 0 are done** (MagicDNS, HTTPS
   Certificates, the `funnel` node attribute). If not, give the person the three
   steps again.
3. **Pick the port without asking:** `tailscale funnel status` and
   `tailscale serve status` show what is in use. Use 443 if it is free, else
   8443, else 10000 — the only ports Funnel serves — and never replace an
   existing entry.
4. **Turn it on:** `tailscale funnel --bg --https=<port> localhost:<ComfyUI's
   port>`. On a tailnet where Funnel has never been used, it prints a link to
   enable it instead; give the person the link, then run it again.
5. `tailscale funnel status` shows the address: `https://<machine>.<tailnet>.ts.net`,
   plus `:<port>` unless the port is 443. That is the deployed `COMFY_URL`.

Funnel is public, not tailnet-private — that is the point, since Vercel is not
on their tailnet — so the ComfyUI-Login token is what guards it. Tailscale
*Serve* is the private variant and will not work.

**Checking it from this machine:** do not trust `nslookup`, `dig` or
`Resolve-DnsName` here — Tailscale answers `*.ts.net` lookups locally with the
private address, even when you ask a public resolver, so a loop waiting for the
public address never ends. Ask DNS-over-HTTPS instead, and connect to the
address it gives:

```bash
curl -s "https://cloudflare-dns.com/dns-query?name=<host>&type=A" -H "accept: application/dns-json"
curl -s -o /dev/null -w "%{http_code}\n" --resolve <host>:<port>:<ingress ip> https://<host>:<port>/system_stats       # 401 or 302
curl -s -o /dev/null -w "%{http_code}\n" --resolve <host>:<port>:<ingress ip> https://<host>:<port>/system_stats -H "Authorization: Bearer <token>"  # 200
```

No `Answer` yet is normal for the first few minutes: go on with Phase 7 and
check again before Phase 8. Phase 8's deployed check is the real gate.

**Never** a port forward straight to ComfyUI over plain HTTP: the token and
prompts would cross the internet in cleartext.

## Phase 7 — Configure and verify locally

```bash
cp .env.example .env.local
```

- `COMFY_URL=http://127.0.0.1:<port>` — the port from the launch script.
- `COMFY_API_TOKEN=` the token from Phase 5, with **every `$` escaped as `\$`**
  — dotenv reads `$2b` as a variable and silently blanks it:
  `COMFY_API_TOKEN=\$2b\$12\$AbCd...`
- `APP_ACCESS_TOKEN=` a new random value (`openssl rand -hex 32`, or
  `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`). This is
  **the app's password** — what they type at the deployed app's gate. Tell the
  person, in these words or close to them: *"Your app password is the
  `APP_ACCESS_TOKEN` line in `.env.local` in this folder. I made a long random
  one. If you'd like something easier to type, change that line now and I'll
  use yours when we deploy. Changing it later means updating it in Vercel too —
  any coding agent can do that for you."*

**Choose where prompts are rewritten.** Every generating workflow turns the
person's one line into the detailed format MiniMax H3 was trained on, and
something has to do the rewriting. Offer both, and recommend the first unless
they already have a Vercel account they want to use:

1. **On this machine — no account, recommended to start.** Two models work.
   Recommend by the card's VRAM (`nvidia-smi`), say why, and let the person
   choose — they can download both and switch in the app at any time:

   | VRAM | Recommend | Why |
   | --- | --- | --- |
   | **24 GB or more** | `local-director-27b` — Qwen 3.8 27B (17 GB) | The best writer: richer shots, every music video scene in a different place, closest to their idea. About 40 seconds a brief, 20 GB at its peak. The stock model rather than an uncensored one, though it refused nothing in testing |
   | **16 GB** | `local-director` — Gemma 4 12B uncensored (12 GB) | Peaks at 14 GB, about 20 seconds a brief. Plainer writing. Also the one to take on a 24 GB card if they want speed, or a model with its refusals trained out |
   | **12 GB** | The gateway, below | The local models are tight or do not fit; see the 12 GB troubleshooting rows if they insist on Gemma |

   `pnpm models:download --comfy <ComfyUI folder> --extras local-director-27b`
   (or `local-director`, or both). The app offers whichever the machine has,
   the 27B first, and a browser that has not chosen starts on this machine
   with it. The person can change it from the **Local** / **Gateway** button
   in the header — *Where is the prompt rewritten?* and *Local model*; the
   choice is remembered per browser.
2. **The Vercel AI Gateway — a key.** Hosted models, faster, each with a content
   policy. The person creates a key at
   [vercel.com/dashboard](https://vercel.com/dashboard) → **AI Gateway** → **API
   Keys** ($5 of free credit a month) and enters it themselves, through the key
   button in the app's header (it writes
   `custom_nodes/comfyui-vercel-ai-gateway/config.json` on whichever ComfyUI
   `COMFY_URL` points at, and is never stored by the app) or as
   `AI_GATEWAY_API_KEY` in ComfyUI's launch environment. Re-run
   `pnpm check:nodes` afterwards: its `NO KEY` line should be gone.

They can have both and switch at any time. Without either, the **Send my prompt
as written** switch beside each prompt skips the rewrite — mention it, but not
as the normal way to run.

**Then check, start the app, and run the test generation yourself:**

```bash
pnpm check:nodes --workflows minimax-h3,minimax-music3   # the set from Phase 3; exit 0
pnpm check:workflows        # the app's own definitions; needs no ComfyUI
pnpm dev                    # in the background
pnpm smoke --director local --local-model <qwen38-27b | gemma-4-12b-heretic> # or --director gateway
```

`check:nodes` asks ComfyUI for every node class, model file and dropdown option
the workflows use, names the pack behind each missing class, and reports whether
the gateway pack can see a key. Pass `--workflows` the same list you gave
`models:download` in Phase 3; without it every workflow is checked, and the
files of the ones they left out fail it. If they took them all, leave it off. Exit **0**: everything required is there. **1**:
something is missing — fix it from its output, mapping classes to packs in
Phase 2. **2**: it could not ask at all — ComfyUI not running, wrong
`COMFY_URL`, or the token rejected (check the `\$` escaping first).

`pnpm smoke` queues a five-second Text to Video through the app with the
switches a new user gets (Turbo, SageAttention), waits, and prints
ComfyUI's own error if it fails. **It is the gate.** On failure, fix the cause
from the error and the troubleshooting table, and run it again; the first run
on a new machine is where SageAttention's headers (Phase 2) and the GPU timeout
(Phase 4) show up. The first run also loads every model from disk, so allow
several minutes.

Once it passes, have the person open <http://localhost:3000>, enter the app
password, see the clip in the history, and try one generation of their own.

## Phase 8 — Deploy to Vercel

Only once `pnpm smoke` has passed. Ask before deploying, then do the steps
without further questions.

```bash
npm i -g vercel      # if needed — npm, not pnpm: pnpm's global bin is often not on PATH
vercel login         # run it in the background; give the person the link it prints
```

**The project.** Name it `sorant` unless they want another name. Check the name
is free first — `vercel project inspect <name>` fails with `project_not_found`
when it is — and if it is taken, use `sorant-<their username>`. Then:

```bash
vercel link --yes --project <name>
```

Linking may report `Failed to link <repo>. You need to add a Login Connection
to your GitHub account first.` That is harmless — the project is created and
linked, and deploys go through the CLI. Linking also rewrites `.env.local` with
the project's Development variables and a `VERCEL_OIDC_TOKEN`; afterwards,
`pnpm check:nodes` exiting 0 is the check that `COMFY_URL` and
`COMFY_API_TOKEN` there are still right.

**Environment variables**, Production scope. **Values here are literal — no `$`
escaping.** `vercel env add` reads the value from stdin; pipe it in without a
trailing newline (in bash, `printf '%s' "$VALUE" | vercel env add NAME
production`; from PowerShell, run that through Git Bash), never paste it into
chat, and never pass `NAME=value` as an argument:

- `COMFY_URL` — the **public** address from Phase 6, never localhost
- `COMFY_API_TOKEN` — the unescaped token
- `APP_ACCESS_TOKEN` — whatever is in `.env.local` now, including a value the
  person changed

**A private Blob store, for uploads over 4 MB.** Vercel refuses request bodies
over 4.5 MB, so larger uploads go from the browser to Blob and are copied to
ComfyUI from there. Name it after the project:

```bash
vercel blob create-store <name>-uploads --access private --yes
vercel deploy --prod --yes
```

A name already taken in their account fails with a 409: ask whether to connect
the existing store or create one with another name. `create-store` adds
`BLOB_READ_WRITE_TOKEN` to every environment. The upload ceiling is 100 MB,
matching ComfyUI's `--max-upload-size 100`; raise `LARGE_UPLOAD_MAX_BYTES` in
`src/lib/upload-limits.ts` together with that flag.

**Verify it yourself before handing over:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://<app>/api/health        # 401: the gate is on
curl -s https://<app>/api/health -H "x-app-token: <APP_ACCESS_TOKEN>"    # reachable, authorized, secure: true
pnpm smoke --url https://<app> --director local                          # or gateway — the gate
```

`reachable: false` usually means Caddy has no certificate yet, the router
forward is missing, Funnel's public DNS is not there yet (Phase 6), or
`COMFY_URL` is wrong. Then the person opens the deployment, enters the app
password, and — if they use the local rewrite — sets it to **This ComfyUI
machine** in that browser too.

Production on Vercel's Hobby and Pro plans is public: `APP_ACCESS_TOKEN` is the
only gate. Vercel's own login protects preview URLs, not production.

**If they connect the GitHub repo instead:** a push to `main` deploys
production, other branches get previews. If the fork is public, leave **Git
Fork Protection** on (Project Settings → Security) — it stops a stranger's pull
request from building with their environment variables, ComfyUI token
included.

## Phase 9 — Report back (optional)

Setups that hit a problem are how this runbook gets better. At the end — or as
soon as you are stuck — write up your running list (ground rules) and **ask the
person** whether you may file it as an issue on the project. Say what it
contains and that it has no passwords or tokens in it.

The report, in markdown:

- **Environment:** OS and version, GPU and VRAM, RAM, ComfyUI version, how it
  was installed (portable, clone, Desktop), Python and PyTorch versions, which
  agent you are.
- **Outcome:** each phase's gate, passed or failed.
- **Problems:** every error (the command and its message), every place this
  runbook was wrong or silent — quote the line and say what it should say — and
  what fixed it.

**Leave out** tokens, passwords, keys, the Funnel or DDNS hostname, the Vercel
project URL, and usernames in paths (write `C:\Users\<user>`).

If they agree and `gh auth status` succeeds:

```bash
gh issue create --repo pwillia7/sorant --label setup \
  --title "Setup report: <OS>, <GPU>, <worked / stuck at Phase N>" --body-file <report.md>
```

Otherwise save the report to a file, and give them
<https://github.com/pwillia7/sorant/issues/new?template=setup-report.md> to paste
it into. If they decline, that is fine — tick the gate and move on.

## Updating an existing install

For a Soran’t that is already set up and working, when the person wants the
latest version. The ground rules above still hold — ask before restarting
ComfyUI and before deploying.

**The question that decides everything** is whether the update changes what the
ComfyUI machine needs. Most releases are app-only: deploy them from any
machine. Some add a node class, change how a graph drives a node, or name a new
model file — and deploying the app ahead of the machine is how a workflow ends
up failing several minutes after Generate on a class nobody recognises. The
repo answers the question itself: `machine-requirements.json`, at its root,
lists everything the graphs need from the machine, and its `fingerprint` changes
exactly when that does.

Copy this into your reply and keep it current:

```
Update progress:
- [ ] U1 Where          on the ComfyUI machine or not; deployed version and
                        fingerprint known (or known to be unknown)
- [ ] U2 Kind           app-only or machine changes, from the fingerprints
- [ ] U3 Machine        (machine changes only, on the ComfyUI machine)
                        gate: `pnpm check:nodes` exits 0 on the new version
- [ ] U4 App            gate: deployed, header shows no update notice, no
                        workflow card says the machine is missing anything,
                        one run finished
```

### U1 — Where you are, and what is deployed

- **Is this the ComfyUI machine?** The same test as Phase 0: a ComfyUI install
  on this computer that the app's `COMFY_URL` points at. If you cannot tell,
  ask.
- **What is deployed.** The deployment, not this clone, is what is being
  updated — a clone on a laptop can be older or newer than what is live. Ask
  the deployment: `GET <app URL>/api/updates` with the header
  `x-app-token: <APP_ACCESS_TOKEN>` returns `current` (its version) and
  `fingerprint`. Use the token from `.env.local` if it is there, without
  printing it; otherwise have the person open
  `<app URL>/api/updates?token=<their APP_ACCESS_TOKEN>` in their browser and
  read you the two values — never the token.
- A deployment from before 0.2.0 has no `/api/updates` (a 404). Its fingerprint
  is unknown: treat the update as having machine changes unless U3's
  `check:nodes` says otherwise.

### U2 — App-only, or machine changes?

```bash
git fetch --tags origin
git tag --sort=-v:refname | head -1        # the latest release; or use origin/main
git show <target>:machine-requirements.json | grep -m1 '"fingerprint"'
```

- **Same fingerprint as deployed:** app-only. Skip U3.
- **Different, or unknown:** machine changes. Say what they are before doing
  anything: `git diff <deployed tag>..<target> -- machine-requirements.json`
  shows them — a new class means a new or updated node pack, changed `inputs`
  on a class mean an updated pack (or a newer ComfyUI for a core node), a new
  model means a download. The release notes on GitHub say the same in words,
  under **ComfyUI machine changes**.
- **Optional downloads are not in the fingerprint** — the local director
  models, the VHS tape LoRA, the SeedVR2 upscalers — because no graph needs
  them. A release that adds one says so in its notes, as **New optional
  download**. It is still app-only: deploy it, then offer the download as its
  own step on the ComfyUI machine. For a new local director model, recommend
  from the card's VRAM as in Phase 7.
- **A launch line with `--vram-headroom`** — which this runbook used to
  recommend — makes Qwen 3.8 27B up to nine times slower, and `check:nodes`
  says so. If they use the 27B, offer to take it off and restart ComfyUI
  (ask first).

### U3 — Machine changes, on the ComfyUI machine

**If you are not on the ComfyUI machine, stop here** — unless this machine
can reach that ComfyUI (`COMFY_URL` and `COMFY_API_TOKEN` in `.env.local`) and,
with the target version checked out, `pnpm check:nodes` exits 0: then the
machine already has everything, and U4 can go ahead. Otherwise tell the person
what the update needs on the machine, and that they should run this same update
there; do not deploy the app first.

On the ComfyUI machine:

1. Check out the target: `git pull --ff-only` (or `git checkout <tag>`), then
   `pnpm install`. Local changes in the clone: stop and ask — except
   `src/lib/workflows/generated/`, which `pnpm sync:models` and every local
   build rewrite from the live gateway catalog. Discard that with
   `git checkout -- src/lib/workflows/generated/` and pull; the release carries
   its own copy, and the next build regenerates it anyway.
2. Node packs: `git pull` in each pack the diff points at — in
   `custom_nodes/` — and reinstall its requirements with ComfyUI's own Python,
   as in Phase 2. A pack not yet installed: install it as in Phase 2. When the
   diff does not make it clear which pack, update all six from Phase 2.
3. Models: `pnpm models:download` for the workflows the person uses — it fetches
   only what is missing, and says how much before it starts. Ask before a large
   download.
4. ComfyUI itself, if the release notes say so.
5. Restart ComfyUI from its launch script (ask first — it may be rendering).
   Gate: `pnpm check:nodes` exits 0 (with `--workflows` for the set the
   person uses), and `pnpm smoke` passes against a local `pnpm dev`.

### U4 — The app

1. If not already done in U3: `git pull --ff-only` (or check out the tag) and
   `pnpm install` — discarding a regenerated `src/lib/workflows/generated/`
   first, as in U3.
2. Deploy to the **existing** project. On a machine that has deployed before,
   `vercel deploy --prod`. On one that has not, `vercel link` first and pick the
   existing project — never create a second one. Its environment variables and
   Blob store are already there: do not add them again.
   - If the person deploys through Git instead (a fork connected to Vercel):
     **Sync fork** on GitHub, and the push to `main` deploys.
   - Local-only installs: restart `pnpm dev` or `pnpm start`; nothing to deploy.
3. Verify on the deployment: `pnpm smoke --url https://<app>` passes (add
   `--director local` if they use the local rewrite), and the person sees no
   update notice in the header and no workflow card saying the ComfyUI machine
   is missing something.

## When something is wrong

| Symptom | Look at |
| --- | --- |
| Pill reads **Offline** | `COMFY_URL`; ComfyUI running; port reachable from where the app runs |
| Pill reads **Auth failed** | `COMFY_API_TOKEN`; the `$` escaping; whether the password was reset since |
| Works locally, fails deployed | `COMFY_URL` still `localhost`, or `$` escaped in Vercel where it should not be |
| Deployed health says `reachable: false` right after Phase 6 | Caddy: the router forward, the `bind` address, or the certificate (its log). Funnel: public DNS is not there yet; check with DNS-over-HTTPS (Phase 6) |
| A long video sits on a grey box, short clips load | `COMFY_URL` is a Funnel, whose relayed bandwidth cannot carry a file that size within a function's five minutes. Move to Caddy (Phase 6) |
| Valid token still rejected | ComfyUI launched with `--enable-cors-header <specific-origin>`: ComfyUI-Login only checks the bearer token when that matches, and server-side calls send no Origin. Drop the flag or set it to `*` |
| Every API call gets 401 or a redirect to `/login` | No password set yet, or no token sent — Phase 5 |
| A pack fails to import at startup | Its requirements were installed into the wrong Python. Reinstall with ComfyUI's own |
| `tcc.exe … returned non-zero exit status 1` on the first run | The portable Python has no `Include\`/`libs\` — Phase 2. A stale system `CUDA_PATH` can cause the same; check it points at an installed CUDA |
| Fails with SageAttention on, works with it off | The `sageattention` / `triton-windows` packages or the headers — Phase 2. Fix it rather than leaving the switch off |
| `check:nodes` says `COMFY_URL is not set` but `.env.local` sets it | An old copy of the scripts reading a CRLF file; pull, or save `.env.local` with LF endings |
| `check:workflows` says `machine-requirements.json` is stale on a fresh clone | An old copy reading CRLF; pull. Do not commit a regenerated file to fix it |
| A run fails naming a node class | `pnpm check:nodes` — a pack is missing |
| Only the **Edit** button fails | One of the FLUX Kontext files; `models:download --workflows image-edit` |
| Fails at the rewrite, no key | Set up a rewrite — Phase 7. Either a gateway key, or the local director chosen in the app |
| Fails at the rewrite, no reason | Usually a refusal. Change **Rewrite model** behind the header's Gateway button, or use the local director |
| Rewrite refused: model not in the list | The gateway retired it. Redeploy: the build runs `pnpm sync:models`. Never commit the regenerated file in a person's clone — it blocks the next `git pull` |
| `check:nodes` fails only on models for workflows they did not choose | Run it with `--workflows` and the set from Phase 3 |
| 12 GB card, Linux: `illegal memory access`, Xid errors in `dmesg`, or a ComfyUI that will not let go of its port | Dynamic VRAM on a small card. Add `--disable-dynamic-vram`; if Xid errors continue, the `comfy-kitchen` CUDA backend is the next suspect. Then leave ComfyUI at its normal VRAM policy with `--reserve-vram 1.5` rather than `--lowvram` |
| 12 GB card: the local director takes an hour, or fails `Expected a cuda device, but got: cpu` | `--lowvram` has put Gemma on the CPU (the error is a ComfyUI bug on that path). Drop `--lowvram`; if it still does not fit, use the gateway rewrite instead |
| "The local director is chosen but … is not in" | `models:download --extras local-director` (or `local-director-27b`), or switch back to the gateway |
| The 27B takes minutes over a brief that usually takes forty seconds; `check:nodes` says `slow … --vram-headroom` | Take `--vram-headroom` off ComfyUI's launch line and restart it. With it, Dynamic VRAM keeps part of the model in system RAM and streams it over PCIe for every token |
| `TextGenerate takes no mtp` from `check:nodes` | ComfyUI is too old for the 27B. Update it |
| Large uploads fail deployed, work locally | No Blob store — Phase 8 |
| A job shows as **Lost** | ComfyUI restarted and dropped its history |
| "Contact was lost" | The connection dropped, not the workflow. Check the pill and resubmit |
| The Windows machine restarts during step 1 | The TDR values — Phase 4. Display event 4101 in the System log confirms it |
| The deployed app goes Offline when you close your session | ComfyUI was started from your shell. Start it from its launch script in its own window — Phase 2 |

`/api/health` reports `reachable`, `authorized` and `secure` separately, so it
tells "cannot connect" from "connected but refused".

## Done when

- `pnpm check:nodes` (with `--workflows` for a partial set) exits 0 against
  the `COMFY_URL` the app uses.
- `pnpm smoke` has passed locally, and — if deploying — against the deployment.
- ComfyUI-Login is on, and the public URL refuses a request without the token.
- The deployment asks for `APP_ACCESS_TOKEN` before anything else.
- Phase 9 offered.

Then tell the person, in a short list:

- **Their two passwords** and what each is for: the ComfyUI password for
  ComfyUI's own web page, and the app password (`APP_ACCESS_TOKEN`, in
  `.env.local`) for the app. How to change the app password later: edit
  `.env.local` and the Vercel variable, then redeploy — or ask any coding agent.
- **The app's address**, if deployed, and that the rewrite choice is set per
  browser.
- **How to start ComfyUI** after a reboot: its launch script.
- **What they skipped:** workflows not downloaded, optional sets, switches to
  keep off because a pack would not install.
- **Anything pending:** a Windows reboot, a Node upgrade still to make permanent
  from an Administrator terminal.

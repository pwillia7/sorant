---
name: setup
description: Sets up a ComfyUI machine to run Soran't, then deploys the app to Vercel. Runs on the ComfyUI machine itself — installs the custom node packs, downloads the models, applies the Windows GPU fixes, locks ComfyUI with ComfyUI-Login, verifies a generation, and deploys. Use when someone wants to get this running against their ComfyUI, find which nodes or model files are missing, set or reset the ComfyUI password, make ComfyUI reachable from the internet, fix a connection that reports Offline or Auth failed, fix uploads failing once deployed, or ship it to production.
user_invocable: true
---

# Setting up Soran’t

Read [`docs/agent-setup.md`](../../../docs/agent-setup.md) from the repository
root, all of it, and follow it.

That runbook is the single source of truth and is deliberately tool-neutral, so
this repo stays usable from any coding agent rather than just one. This file
exists only because skill discovery paths differ per agent — it is a pointer,
not a copy. If something here needs correcting, correct the runbook.

What it asks of you, worth carrying in before you start:

- **You are on the ComfyUI machine, and you do the work** — install the node
  packs, run `pnpm models:download`, edit the launch script, read the token
  from ComfyUI-Login's file. If ComfyUI is not on this machine, stop and say
  the setup has to run where it is.
- **Copy its progress checklist into your reply** and tick each gate from a
  command's output, not from what the person says happened.
- **Password before reachability.** ComfyUI-Login has no default password and
  is open until one is set; never expose ComfyUI before the person has chosen
  it.
- **Their secrets stay theirs.** The person types the ComfyUI password, the AI
  Gateway key and the Hugging Face token; you never print a token.
- **Be prescriptive, and run the test generation yourself.** Use the
  runbook's defaults without offering menus; `pnpm smoke` is the gate, and you
  fix what it reports before involving the person.
- **Offer the prompt rewrite on this machine** (no account) alongside an AI
  Gateway key, and recommend which local model from their card's VRAM — Qwen
  3.8 27B on 24 GB, Gemma 4 12B on 16 GB, the gateway below that — then let
  them choose (the runbook's Phase 7 table). Tell the person their app
  password is in `.env.local` and can be changed.
- **No `--vram-headroom` on the launch line.** Older versions of the runbook
  added it; it makes the 27B local director up to nine times slower and was
  never shown to prevent anything. The restarts it was meant for are fixed by
  `TdrDelay`.
- **Reach ComfyUI through DuckDNS and Caddy**, HTTPS on the machine itself.
  Tailscale Funnel is only for when no port can be forwarded: its relayed
  bandwidth cannot carry a long music video or a 4K upscale.
- **Keep a list of what went wrong**, and at the end ask whether to file it as
  a setup report on the project's GitHub.
- **Ask before anything outward-facing or system-wide** — the registry,
  restarting a ComfyUI that may be rendering, a system service, a firewall
  rule, a router port forward, Tailscale Funnel, Vercel projects,
  environment variables, deploying.

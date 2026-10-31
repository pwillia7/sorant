---
name: update
description: Updates an existing Soran't install to the latest release. Works out first whether the update is app-only (deployable from any machine) or changes what the ComfyUI machine needs (node packs, model files), and only deploys the app once the machine has what the new version asks for. Use when someone wants to update, upgrade or pull the latest Soran't, sees the "Update" notice in the app header, or a workflow card says their ComfyUI is missing something.
---

# Updating Soran’t

Read the **Updating an existing install** section of
[`docs/agent-setup.md`](../../../docs/agent-setup.md) from the repository root,
and follow it.

That runbook is the single source of truth and is deliberately tool-neutral.
This file is a pointer, not a copy — if something here needs correcting,
correct the runbook.

What it asks of you, worth carrying in before you start:

- **The deployment is what is being updated**, not this clone. Ask it its
  version and fingerprint (`/api/updates`) before deciding anything.
- **App-only or machine changes** is decided by comparing the
  `machine-requirements.json` fingerprint, not by guessing from the changelog.
- **Never deploy the app ahead of the ComfyUI machine.** If the update changes
  what the machine needs and you are not on it, stop and say so — unless
  `pnpm check:nodes` against it passes on the new version.
- **Deploy to the existing Vercel project** — never create a second one, never
  re-add its environment variables.
- **Optional downloads and launch-line advice are not in the fingerprint.**
  Read the release notes for a **New optional download** (a local director
  model, recommended by the card's VRAM), and act on what `pnpm check:nodes`
  flags — `slow … --vram-headroom` means taking that flag off ComfyUI's launch
  line, which older setups were told to add.
- **Ask before** restarting ComfyUI and before deploying. Never print a token.

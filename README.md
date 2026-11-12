# Local Vault Agent

A local AI agent (harness) that runs inside Obsidian. Designed for one scenario: **using Obsidian on your phone and letting the model read and write the whole vault to get work done** — instead of copy-pasting text into a chat box.

> Status: early release (v0.1.0). Verified on Android (real device, 44-item self-test) and desktop. All writes go through a diff dialog that you confirm.

## Why a plugin, not a standalone app

A standalone Android app would have to fight for vault access (scoped storage, SAF, no real paths). As an Obsidian plugin, that entire layer disappears:

- The host app already has vault access; the plugin reads and writes through `app.vault.adapter`
- `metadataCache` provides frontmatter / tags / links / backlinks for free
- `workspace` / `editor` APIs enable in-place edits and diff previews
- One codebase covers Android, iOS and desktop

The trade-off: no Node.js inside the plugin — no shell, no `git`, no `ripgrep`. See [design docs](docs/02-架构设计.md) (Chinese).

## What it can do

| Concern | Approach |
|---|---|
| Where it runs | Everything in the plugin (agent loop, retrieval, tool execution); only inference calls go to the model API |
| Model access | OpenAI-compatible protocol via `requestUrl`; works with DeepSeek, Kimi, and other direct endpoints |
| Writes | **Candidate + diff preview + manual confirm** — never silently overwrites |
| Editing | Prefers `patch_file` (exact replacement) over whole-file rewrites |
| Long tasks | Checkpoint after every step; resume after being killed |
| Retrieval | v0 uses keyword/structural search; vector search intentionally deferred |
| Memory | Bounded memory files (working memory / conversation log), injected into the system prompt |
| Privacy | A read-only mode disables every write tool at once |

Tools include: `read_file` / `read_files` (batch) / `list_files` / `search` / `search_by_tag` / `list_by_frontmatter` / `get_links` / `get_backlinks` / `patch_file` / `create_note` / `write_file` / `move_note` / `trash_note` / `trash_folder` / `open_note` / `ask_user` (pausable with tappable options) / `record_memory` / `use_skill` / `read_checklist`.

Safety rails: sensitive files (`.env`, keys, credentials) are refused for both read and write; `.obsidian/` is off-limits; deletions go to the trash, never hard-deleted; after a configurable number of changed files every write requires individual confirmation; consecutive tool failures trip a circuit breaker.

## Network use

This plugin makes network requests, and you should know exactly what crosses the wire:

- **Where**: only to the OpenAI-compatible endpoint **you** configure in the plugin settings. The default is `https://api.deepseek.com`. The plugin ships with no built-in provider and sends nothing anywhere until you enter an API key.
- **What**: during a task, the notes it reads (or excerpts of them), file names, and tool results are sent to that endpoint as part of the model prompt — this is how the model does its work. Conversation history is also sent so the agent can refer back to earlier turns.
- **What is *not* sent**: there is no telemetry, no crash reporting, no analytics, and no request to any host other than the endpoint you configured. Your API key is stored in Obsidian's SecretStorage (with a documented fallback to local settings), never uploaded anywhere.
- **Local artifacts**: run checkpoints, logs, and oversized tool results are written under `.obsidian/plugins/local-vault-agent/` inside your vault and never leave it unless your own sync service copies them.

Turning on **read-only (privacy) mode** in settings disables all write tools but does not change the network behavior described above — inference always requires the endpoint.

## Quick start

1. Install (from release assets: `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/local-vault-agent/`, or via BRAT while it awaits the community catalog)
2. Enable the plugin in Obsidian (on mobile, `isDesktopOnly` is `false`)
3. Settings → Local Vault Agent: fill in Base URL + API Key, press "Test connection"
4. Open the Agent panel from the ribbon and give it a task, e.g. "list all notes tagged #book"

## Development

```bash
npm install
npm run build      # typecheck + bundle to main.js
npm test           # 206 unit & integration tests
```

A 44-item on-device self-test (no model calls, no token cost) can be triggered by placing a `selftest.flag` file in the plugin directory and reloading the plugin; the report lands in `selftest-report.json`.

Design documents (Chinese) live in [`docs/`](docs/01-需求与场景.md): requirements, architecture, tool set, mobile constraints, roadmap, risks, and ADRs.

## License

[MIT](LICENSE)

# 02 Architecture

English | [简体中文](02-架构设计.md)

## 1. Layers

```
┌────────────────────────────────────────────────────────────┐
│ UI layer     ChatView / DiffModal / settings tab            │
├────────────────────────────────────────────────────────────┤
│ Session      AgentLoop (multi-turn + tool dispatch)         │
│              └─ Checkpoint (run-state persistence)          │
├────────────────────────────────────────────────────────────┤
│ Tools        tools.ts: read / patch / search / ...          │
│              └─ Guardrails: paths, scope, confirmations     │
├────────────────────────────────────────────────────────────┤
│ Storage      app.vault.adapter / metadataCache              │
│              app.workspace / app.commands                   │
├────────────────────────────────────────────────────────────┤
│ Model        provider.ts (OpenAI-compatible)                │
└────────────────────────────────────────────────────────────┘
```

Key point: **the session layer never touches the vault directly** — every file side effect goes through the tool layer, so guardrails only need to be implemented in one place.

## 2. Module responsibilities

| Module | Responsibility | Does NOT do |
|---|---|---|
| `main.ts` | Register views, commands, settings tab; owns the Loop instance | Business logic |
| `agent/loop.ts` | Assemble messages, call the model, execute tools, persist checkpoints | Concrete file operations |
| `agent/tools.ts` | Tool schemas + execution + guardrails | Network requests |
| `agent/provider.ts` | HTTP, auth, response parsing, error normalization | Retry policy (lives in the loop) |
| `util/path.ts` | Path normalization, boundary checks, sensitive-directory detection | File I/O |
| `util/log.ts` | Ring buffer + disk flush | Telemetry |

## 3. Timeline of one run

```
User input
  → loop: assemble system + history + user
  → provider.chat()            ── HTTP ──▶ model
  ◀── assistant.content / tool_calls
  → if tool_calls present:
      executeTool() one by one
        → validate args → read/write → return result (truncated)
        → high-risk ops: pause, wait for the DiffModal outcome
      → results fed back as tool messages
      → write checkpoint
      → back to provider.chat()
  → no tool_calls: finish, show the reply text
```

Stop conditions (any one triggers): no tool calls, `maxSteps` reached, user abort, 3 consecutive tool failures.

## 4. Checkpoint design

**Why it is a must**: Android kills background processes. If an 8-step run gets killed at step 5 and state lives only in memory, what the user sees is "notes half-edited, conversation gone".

Location: `<vault>/.obsidian/plugins/local-vault-agent/state/<runId>.json`

```jsonc
{
  "runId": "20261020-1132-a1b2",
  "createdAt": 1760938321000,
  "updatedAt": 1760938412000,
  "status": "running",          // running | awaiting_confirm | done | failed | aborted
  "step": 4,
  "maxSteps": 20,
  "messages": [ /* full message array */ ],
  "pendingToolCall": { "id": "...", "name": "patch_file", "args": {} },
  "appliedOps": [               // side effects already applied; feeds idempotence & rollback hints
    { "tool": "patch_file", "path": "读书/xx.md", "at": 1760938400000 }
  ],
  "usage": { "promptTokens": 12000, "completionTokens": 800 }
}
```

State machine:

```
running ──needs confirm──▶ awaiting_confirm ──accepted──▶ running
   │                          └──declined──▶ running (feeds back "user declined")
   ├──done──▶ done
   ├──error──▶ failed
   └──user abort──▶ aborted
```

On startup the plugin scans `state/`; any record in `running` / `awaiting_confirm` triggers a prompt: "resume the last task / discard". **Never auto-resume** — silently applying side effects is more dangerous than being interrupted.

### 4.1 Undo this round (reverse replay over the change log)

`appliedOps` is not just for idempotence hints — it is also the data source for "undo this round" (WP3):

- **Capture**: when `patch_file` / `write_file` / `create_note` succeed, the tool already holds the before/after text in hand; attach it to the `undo` field of `appliedOps` and persist it with the checkpoint. If either side exceeds `UNDO_TEXT_CAP` (50k chars), drop it — better un-undoable than "restoring" from truncated text.
- **Replay**: `undo.ts` groups by path and simulates a reverse-order replay; every file is validated first (for patch, the `new` text must occur exactly once in the current content; for write/create, the current content must match the after-version byte for byte). Any single check failing → **skip that whole file and explain each one** — never produce a half-undone state.
- **Persistence**: once fully validated, each file is written exactly once (atomic `vault.process`); undoing a "create" = move to trash when the content matches, never a hard delete.
- **Trade-off**: content-level restoration only, not metadata restoration — move/delete do not take this path (paths moved this round, and files trashed this round, are skipped and explained); the trash remains responsible for them (see ADR-010).

## 5. Conflicts with the editor

The user may edit the same note in the editor while the agent is working on it. Three cases:

| Case | Handling |
|---|---|
| File not open | `vault.process(file, fn)` — atomic read-modify-write |
| File open in the editor | Still `vault.process()`; on mobile the panel is the active view, the `editor` branch was unreachable and has been removed |
| User manually saves mid-run | `vault.process` picks up the latest content before replacing; if the replacement fails (target text changed), the error is fed back to the model |

`patch_file` must verify that the target text matches **uniquely** — zero hits or multiple hits both fail. This is the core safeguard against accidental edits.

## 6. Error taxonomy

| Type | Example | Strategy |
|---|---|---|
| Transient network | Timeout, connection reset | Retry twice, exponential backoff (1s / 3s) |
| Auth | 401 / 403 | Fail immediately, prompt to check the key |
| Rate limiting | 429 | Back off 10s, up to 3 times |
| Invalid request | 400 (model lacks tool support, payload too long) | Fail immediately, prompt to switch models |
| Tool error | File missing, patch no-match | **Do not surface as failure — feed back as a tool message** and let the model correct itself |
| Internal bug | Uncaught exception | Log + abort the run + keep the checkpoint |

"Feeding tool errors back" is the key design: shown `No unique match for patch in 读书/xx.md`, the model usually retries with a different phrasing on its own — far more useful than erroring out at the user. But 3 consecutive failures of the same tool abort the run, preventing a token-burning loop.

## 7. Context budget

Do not count on long context on a phone. Policy:

- Files are read whole by default, but beyond `2000` lines a line range is required
- A single tool result over `20000` chars is truncated, with "truncated, N chars remaining" appended at the end
- Search results cap at `20` hits, each with at most a `200`-char preview
- Beyond `30` history messages, early dialogue gets replaced by one summary (planned for v0.3; the MVP just caps the turn count)

## 8. Why not MCP

MCP solves "let external clients access Obsidian"; this project is "run the agent inside Obsidian". Adding MCP would only add a layer of IPC, and on mobile there is no mature MCP client ecosystem anyway. **Calling the host APIs directly inside the plugin is the shortest path.**

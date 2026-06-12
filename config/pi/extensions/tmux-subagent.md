# tmux-subagent — design & wiring

How `tmux-subagent.ts` runs pi subagents in their own tmux windows, and how the
parent stays in control without screen-scraping. Read this before changing the
IPC, the stop/approval flow, or the window-tracking logic — several pieces look
redundant but each one fixes a specific failure we hit in testing (see
[Gotchas](#gotchas-the-non-obvious-bits)).

## What it gives you

- **Tools**: `launch_agent` (blocking or background), `agent_reply`.
- **Commands**: `/agents` (list), `/agents-clear` (drop finished cards).
- A **widget card** per live agent above the editor (name · model, status pill,
  elapsed, task), driven by a 1s tick.

## The two processes

```
parent pi (this session)                child pi (one per agent)
─────────────────────────               ─────────────────────────
launch_agent tool                        pi -e <tmpBase>.ts   (a generated extension)
  spawns tmux window  ───────────────▶   runs in `tmux new-window -d`
  registers AgentEntry
  starts 1s tick loop                    child temp extension:
                                           session_start → send task, write "running"
  pollAgentState() reads  ◀───── .state.json ── turn_start    → write "running"
  state file every tick                    guardrails prompted → write "stopped"(+ctx)
                                           agent_end     → write "done"(+output,usage)
  agent_reply / inbox     ───── .inbox.txt ──▶ poll inbox → sendUserMessage()
```

The child is a **completely ordinary `pi` session**. The only special thing is
the generated `-e` extension that bridges it to the parent. There is no shared
memory and no socket — coordination is **file-based IPC** in `os.tmpdir()`.

> ⚠️ `os.tmpdir()` on macOS is `$TMPDIR` (`/var/folders/.../T`), **not** `/tmp`.
> If you debug by hand, resolve the dir with `node -e 'console.log(require("os").tmpdir())'`.

### IPC files (`{tmpBase} = $TMPDIR/pi-agent-<timestamp>`)

| File | Direction | Purpose |
|------|-----------|---------|
| `{tmpBase}.ts` | parent → child | the generated child extension; passed as `pi -e`. Parent unlinks it on finish. |
| `{tmpBase}.state.json` | child → parent | `{status, output?, reason?, prompt?, model?, usage?}`. The parent polls this. |
| `{tmpBase}.inbox.txt` | parent → child | a queued user message; child injects it via `sendUserMessage` then deletes the file. |

### State machine (`status` in `.state.json`)

```
running ──(guardrails prompt)──▶ stopped ──(answered)──▶ running ──▶ done | error
```

- `running` is (re)written on `session_start` and every `turn_start`.
- `stopped` is written by the child's `guardrails:action:prompted` handler and
  carries a `prompt` object (`kind`, `toolName`, `path`, `reason`).
- `done`/`error` is always written on `agent_end` (see gotcha #1).

## launch_agent: blocking vs background

Both modes spawn the window, register the agent, and start the tick. They differ
only in how the **result** is returned:

- **blocking** (default): `execute()` returns a `Promise` that `finishAgent`
  resolves with a normal tool result (output + usage). Renders inline like any
  tool. The execute `signal` is wired so cancelling the turn kills the child.
- **background**: `execute()` returns immediately; `finishAgent` delivers the
  result later via `pi.sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`.

`AgentEntry.mode` records which, and `finishAgent` branches on it.

## The parent's loop (`pollAgentState`, every 1s)

For each tracked agent:
1. Refresh `windowTarget` from the **pane id** (`windowForPane`) — indices move.
2. Read `.state.json` and act on transitions:
   - `running` while we thought it was `stopped` → it resumed elsewhere; abort
     any open parent dialog and clear the stopped flag.
   - `stopped` (new) → `onAgentStopped` (inline dialog, see below).
   - `done`/`error` → `finishAgent`.
3. If we still think it's `running` but the **pane is dead** (`isPaneAlive`),
   the child crashed without writing `done` → `finishAgent` with whatever we have.

`finishAgent` → `cleanupAgent` (kill window by pane id, unlink the 3 files, clear
the widget, drop from the map, stop the tick if nothing is left) → then resolve
(blocking) or follow-up (background). The result text appends any inline
permission decisions.

## Stop / approval flow (the interesting part)

When a child hits a guardrails **path-access** prompt it pauses on
`ctx.ui.custom` *in its own window* and emits `guardrails:action:prompted`
first. The child writes `stopped` + the prompt context. The parent then:

`onAgentStopped` → `promptInParent`:
- If we have a UI, no dialog is already open, and `prompt.kind === "confirmation"`,
  show a `ctx.ui.select` **inline in the parent** with the tool + path context:
  `Allow once` / `Deny` / `Open the agent's tmux window`.
- The choice **drives the child's modal via `tmux send-keys` to its pane**:
  - `Allow once` → `Enter` (the modal's first option is always "Allow once")
  - `Deny` → `Escape` (Esc = deny in that modal)
  - `Open …` → `tmux select-window` so the human gets the advanced grant options.
- On Allow/Deny we record the decision, toast it immediately, and `markResumed`
  (which **rewrites the state file to `running`** — see gotcha #2).

If we can't show the dialog (no UI, dialog busy, or a non-path-access prompt),
`notifyNeedsAttention` falls back: background → a follow-up message pointing at
the window; blocking → a toast (the parent LLM is busy, so the human acts).

The decision is surfaced two ways so nothing has to poll:
- **immediately** to the human via `ctx.ui.notify`,
- **into the thread/LLM** by folding it into the final result text.

### Answering in the child window instead

Fully supported and necessary for the advanced grant options. When the human
answers in the window, the child resumes and writes `running` (next `turn_start`)
then `done`. The parent sees that and **aborts any dangling inline dialog** via
`AgentEntry.promptAbort` (an `AbortController` passed to `ctx.ui.select`), so the
two response paths never fight.

## Window tracking

- A window's `session:index` is **not stable** (other windows open/close;
  `renumber-windows` shifts them). We capture the **pane id** (`%N`) at spawn and
  use it for *every* tmux command (`kill-window`, `set-window-option`,
  `send-keys`, `select-window`). The `session:index` is only ever recomputed
  from the pane id for *display*. This is why killing a finished agent can never
  hit one of your other windows.
- The window keeps its `pi:<name>` label because:
  1. the child is launched with `-e PI_SUBAGENT=1`, and `tmux-window-name.ts`
     early-returns when that env var is set (otherwise it renames the window to
     the cwd basename), and
  2. the parent sets `allow-rename off` + `automatic-rename off` on the pane.

## Gotchas (the non-obvious bits)

1. **`agent_end` always writes `done`** — never gate it on "was there a
   guardrails block". An earlier version kept a `blockReason` flag and only
   cleared it via the inbox; if you answered the prompt *in the child window*
   the flag stayed set and the agent was stuck "stopped" forever. The prompt is
   a *transient* signal; the run completing is the authoritative one.
2. **`markResumed` rewrites the state file to `running`.** After we drive the
   modal with `send-keys`, the child can't tell us its modal closed, so the file
   still says `stopped`. Without the rewrite the next tick re-fires the dialog.
   A genuine *second* prompt simply writes `stopped` again.
3. **Inline approval works even in blocking mode.** The 1s tick and
   `ctx.ui.select` run independently of the pending `execute()` promise, so the
   dialog renders while the tool is "running".
4. **`nextTurn` messages don't render until the next prompt.** That's why the
   decision is a `ctx.ui.notify` toast + folded into the result, not a
   `deliverAs: "nextTurn"` message (which looked like it "didn't show up").
5. **`os.tmpdir()` ≠ `/tmp` on macOS** (repeated because it cost real debugging
   time).

## Guardrails coupling (assumptions to re-check on upgrade)

This depends on `@aliou/pi-guardrails` internals
(`config/pi/npm/node_modules/@aliou/pi-guardrails`):

- Events `guardrails:action:prompted` / `:blocked` and their payload shape
  (`reason`, `prompt.kind`, `action.path`, `context.toolName`) — see
  `src/shared/events.ts`.
- `pathAccess` mode defaults to `"ask"` and only prompts when `hasUI` is true
  (`extensions/path-access/index.ts`, `src/core/paths/access.ts`); in `block`
  mode or with no UI it denies outright (no prompt, the agent just gets an error
  and finishes — `done`).
- The path-access modal's key map: **Enter = first option ("Allow once"),
  Esc = Deny** (`extensions/path-access/prompt.ts`). The inline Allow/Deny is
  coupled to this; if the modal is reordered, "Open the agent's tmux window"
  still works as the safe escape hatch. Only `kind: "confirmation"` is
  auto-driven; permission-gate / other prompt kinds fall back to the window.

## Quick manual test

```
launch_agent(name:"t", task:"write \"x\" to /Users/<you>/pi-t.txt then reply OK", mode:"blocking")
```
`~/` is outside the guardrails allow-list, so it prompts. Expect an inline
Allow/Deny dialog; Allow → `OK` inline with usage and a folded-in decision line.
For background mode, drop `mode` or set `"background"` and answer either in the
dialog or the `pi:t` window.
```

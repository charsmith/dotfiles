# pi-chain — design & wiring

How `pi-chain.ts` runs a declared chain of agents as a deterministic pipe, and
how a chain can be either a one-shot pipeline or a **warm, persistent team** you
feed many topics through. Built on the same `lib/agent-spawn.ts` primitive as
`tmux-subagent.ts` — read `tmux-subagent.md` first for the spawn/IPC contract.

## What it gives you

- **Tool**: `run_chain (chain?, input)` — runs a declared chain; each step's
  output becomes the next step's `$INPUT` (`$ORIGINAL` is always the original
  input). Returns the final step's output.
- **Commands**: `/chain` (set the active chain), `/chain-list`, `/chain-show`
  (re-show the last run's flow widget after it auto-dismissed), `/chain-reset`
  (clear the widget + remembered run), `/chain-down` (shut down a warm
  persistent team).
- A **flow widget** above the editor showing each step's status, elapsed, and
  live ↑/↓/cost stats, driven by a 1s tick + `fs.watch`. It **auto-dismisses**
  `DISMISS_AFTER_MS` (10s) after a run reaches a terminal state; the run is
  stashed in `lastRun` so `/chain-show` can bring it back.

## Mental model: a chain is always a live team

"One-shot" and "persistent" are **not** two code paths — they are one model with
two independent axes:

| Axis | Field | Default | Meaning |
|------|-------|---------|---------|
| Team lifetime | `persist` (chain) | `false` | `false` = tear the agents down once the answer is returned (one-shot feel). `true` = keep them warm for the next `run_chain` of this chain. |
| Memory | `clearContext` (chain, per-step override) | `true` | `true` = each topic starts on a clean slate (ephemeral spawn-and-kill). `false` = the agent stays alive across topics so context accumulates. |

So **one-shot = `persist:false`** (shut down after the answer); **persistent =
`persist:true`**; memory is the orthogonal `clearContext` axis. The useful
multi-topic case (researcher → reviewer, fed several topics) is
`persist:true` + a `clearContext:false` step.

## YAML schema

`~/.config/pi/agents/agent-chain.yaml` (and `./.pi/agents/agent-chain.yaml`):

```yaml
dp-research:
  kind: chain
  description: "Research a data platform topic end-to-end"
  persist: false          # default: one-shot (tear agents down after the run)
  clearContext: true      # default: fresh context per topic
  steps:
    - agent: dp-researcher       # agent def name → ~/.config/pi/agents/<name>.md
      prompt: "$INPUT"           #   (carries persona, tools, skills, spawn policy)
    - system_prompt: "..."       # OR an inline persona (alternative to `agent`)
      model: anthropic/claude-haiku-4-5   # optional per-step model override
      clearContext: false        # per-step override: this step remembers topics
      prompt: |
        $INPUT
        (original question: $ORIGINAL)
```

- **Step fields**: `agent` (definition name) **or** `system_prompt` (inline
  persona); `model` (optional override); `prompt` (template with `$INPUT` /
  `$ORIGINAL`); `clearContext` (optional per-step override of the chain default).
  `loadChains` errors if a step has neither `agent` nor `system_prompt`.
- **Chain fields**: `kind: chain` (discriminator), `description`, `persist`,
  `clearContext`, `steps`.
- `agent:` is the "more detail" path — the full `.md` definition (frontmatter
  `skills`/`tools`/`spawn_agents` + markdown body as system prompt) is applied to
  the spawned step. `system_prompt:` is the quick inline path. `model:` overrides
  on top of either.

## Two execution paths per step

`run_chain` walks the steps in order. For each, `clearCtx = step.clearContext ??
def.clearContext` selects the path:

### clearContext: true → ephemeral (`runStep`)
Today's behavior: spawn a fresh subagent (`spawnAgentWindow`, non-persistent),
wait for its terminal `done`/`error` state, then **kill the pane** and unlink its
IPC files. No state survives between topics.

### clearContext: false → persistent (`runPersistentStep`)
The agent stays alive across topics:

- **First topic** (no live member): spawn with `persistent: true`; the warm-up
  `task` *is* the first topic. The child's `agent_end` writes status `running`
  (never `done`, so it stays alive) plus an incremented `seq`.
- **Later topics** (member exists): write the next prompt to the member's
  `inboxFile`; the child polls the inbox and injects it via
  `sendUserMessage(msg, { deliverAs: "steer" })`, starting a fresh run.
- **Completion detection**: persistent members never write `done`, so we can't
  watch `status`. Instead the parent records `targetSeq = lastSeq + 1` before
  sending and waits for the state file's `seq` to reach it. `turn_start`/
  `turn_end` writes omit `seq` (treated as in-progress); only `agent_end` bumps
  it — exactly one bump per topic.

This needs **no `coms-bus` involvement** — it reuses the inbox→state IPC contract
that `agent_reply` / background follow-ups already ride on (see `tmux-subagent.md`).

## Live team registry

`liveTeam: { chainName, members: (LiveMember | null)[] }` — a single warm team
keyed by chain name; `members[i]` holds the live agent for persistent step `i`
(`null` for ephemeral steps or not-yet-spawned slots). `LiveMember = { handle,
lastSeq }`.

- A `run_chain` for a **different** chain tears the stale team down first.
- After the run: `persist:false` → `teardownLiveTeam()` (kill panes + unlink
  files); `persist:true` → leave it warm for the next call.
- `teardownLiveTeam()` also runs on chain error (when `!persist`), `session_start`,
  `session_shutdown`, and `/chain-down`.

## Gotchas (the non-obvious bits)

- **`seq` is the only safe completion edge for persistent members.** Don't switch
  back to watching `status` — persistent agents are permanently `running`.
- **Cancel drops the member.** A cancelled topic may still finish in the child and
  bump `seq`; if we kept the member, the next topic's `targetSeq` could already be
  satisfied and return stale output. So `onAbort` calls `killMember` and returns
  `member: null`, forcing a clean respawn.
- **`renderResult` must return a TUI component, not a string.** Pi calls
  `.render()` on the returned value (it's added as a child of a `Box`). Returning
  a raw string throws `child.render is not a function`. Wrap in `new Text(...)`.
- **The flow widget is sticky then auto-dismisses.** On terminal state we
  `scheduleDismiss()` (stop the ticker, stash `lastRun`, null `run` after 10s).
  `/chain-show` cancels the pending dismiss and re-displays; a new run / reset /
  session boundary cancels it too.
- **clearContext + persist interaction.** `clearContext:true` steps are always
  ephemeral (spawn-and-kill) regardless of `persist`; `persist` only governs the
  lifetime of `clearContext:false` (persistent) members. A `persist:true` chain
  made entirely of `clearContext:true` steps keeps no live agents between calls.

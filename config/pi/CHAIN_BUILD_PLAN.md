# Chain Build Plan (Phase 2 — `pi-chain.ts`)

Resumable plan for building the agent-chain orchestrator. Read this top-to-bottom
to pick up where we left off. Companion to `AGENT_PLAN.md` (high-level phases) and
the design docs `tmux-subagent.md` / `coms-bus.md`.

**Status: Steps 1–4 + 6 DONE + verified (shared primitive, pi-chain skeleton,
the deterministic pipe, flow widget, docs). Step 4.5 ADDED + DONE: persistent
teams (`persist`/`clearContext`) — a chain can now keep its agents warm across
topics, not just run one-shot. Next: Step 5 (dp-synthesizer + real dp-research
chain) and Step 7 (`kind: team` declarative support, still open).**

**Verified live:** the flow widget renders; the `pitch-lab` one-shot chain runs
end-to-end; the `pitch-lab-live` persistent chain keeps a researcher→reviewer
pair warm across multiple topics with the reviewer retaining context.

**Pending a restart-and-eyeball:** the persistent-team feature (Step 4.5) passed
syntax + YAML-parse checks but the new `runPersistentStep` / `seq` flow and
`/chain-down` were implemented after the last live run — confirm on next restart.

---

## The framing (agreed)

Two orthogonal primitives already exist and must stay orthogonal:

- **`tmux-subagent.ts`** — the spawn/visibility layer (tmux window, widget,
  file-IPC state, guardrails approval). *How an agent comes into existence.*
- **`coms-bus.ts`** — the messaging layer (peer-to-peer, async-first, file-IPC
  inboxes keyed by `--project`). *How agents talk.*

Two topologies built on those primitives:

| | TEAM (`coms-bus`) | CHAIN (`pi-chain` — this plan) |
|---|---|---|
| Shape | star / mesh | linear pipeline |
| Time | parallel, order-independent | sequential, order is the contract |
| Lifetime | persistent listeners | **either** ephemeral (default) **or** persistent (Step 4.5) |
| Data flow | request/response, bidirectional | `output(N) → $INPUT(N+1)`, one way |
| Halt | n/a | first `error` halts the pipe |

**Update (Step 4.5):** the "chains are always ephemeral" framing has been
generalized. A chain is now *always* a live team; "one-shot" is just
`persist:false` (tear down after the answer). Two orthogonal axes:
- `persist` (chain): keep the team warm between `run_chain` calls (default false).
- `clearContext` (chain + per-step): fresh ephemeral spawn per topic (default
  true) vs. a persistent agent reused across topics that accumulates context.
This brings the CHAIN and TEAM lifetimes closer together — a `persist:true` +
`clearContext:false` chain is effectively a *linear* persistent team.

**Key insight:** a blocking `launch_agent` *is already one link of a chain* —
it spawns a window, runs the agent, watches `state.json`, waits for `done`, and
returns the output text inline (`finishAgent` → `resolve(...)`). A chain is just
blocking `launch_agent` calls fed end-to-end:

```
$INPUT ─▶ agent1 ─▶ out1 ─▶ agent2 ─▶ out2 ─▶ agent3 ─▶ final
```

So `pi-chain.ts` adds **determinism + declaration + visibility**, NOT new spawn
machinery:
1. `run_chain` tool — a deterministic in-code loop over the link primitive
   (no LLM drift in the hand-off; owns `$INPUT`/`$ORIGINAL` substitution; halts
   on error).
2. YAML declaration — chains are named, reusable units in `agent-chain.yaml`.
3. Flow widget — whole pipeline visible (`✓ ● ○`), error-halt obvious.

**End goal:** YAML describes a team OR a chain as a composable building block, so
bigger patterns nest (a chain step that is a team; a team member that is a chain).
Design the schema with a `kind:` discriminator from day one so nesting is a
natural extension, not a retrofit.

---

## Variables in prompt templates

- `$INPUT` — previous stage's output (or the original user prompt for stage 1).
- `$ORIGINAL` — always the user's first request (so late stages see both).

## Stage output contract (decided)

- **(a) final assistant text** — default. Matches the `output` we already capture
  on `agent_end`. This is the pipe between links.
- **(b) `response_schema` JSON** — opt-in per step in YAML, when the next stage
  needs structured input (reuse the coms-bus schema-validation idea).
- **(c) file artifact** — when a stage writes a large doc (e.g. knowledge base);
  the pipe then carries the path. Future / opt-in.

Default (a), with (b) declarable per step.

---

## YAML schema (uniform across team + chain)

File: `~/.config/pi/agents/agent-chain.yaml` (and eventually `teams.yaml`, or one
combined file). Shared `kind:` discriminator:

```yaml
dp-research:
  kind: chain
  description: "Research a data platform topic and record structured findings"
  steps:
    - agent: dp-researcher
      prompt: "$INPUT"
    - agent: dp-synthesizer
      prompt: "Synthesize these findings into a knowledge base entry:\n\n$INPUT\n\nOriginal question: $ORIGINAL"
      # response_schema: { ... }   # opt-in structured hand-off

dp-research-team:
  kind: team
  description: "Parallel specialists under one project namespace"
  members: [dp-researcher, dp-synthesizer, dp-reviewer]
```

Nesting (later phase): a step's `agent:` could instead be `chain:` or `team:`
referencing another named unit.

---

## Build steps (checkpoints)

### [x] 1. Extract the shared link primitive  ✅ DONE
Created `config/pi/extensions/lib/agent-spawn.ts` — the shared "one link"
primitive. Exports: agent-def loader (`loadAgentDef`, `resolveSkillPath`,
`sanitizeAgentName`), shared types (`AgentState`/`AgentUsage`/`AgentPrompt`/
`AgentStatus`, `AgentDef`), formatting (`fmtTokens`/`fmtElapsed`/`fmtUsage`/
`shortModelName`), tmux helpers (`currentTmuxSession`/`windowForPane`/
`isPaneAlive`/`sendKeysToPane`), `buildChildExtensionSource()` (the IPC bridge
incl. persona splice), and `spawnAgentWindow(opts) → SpawnHandle` (writes IPC
files, opens the window; throws `TmuxSpawnError`).
- `tmux-subagent.ts` now imports these; its `launch_agent` is a thin caller of
  `spawnAgentWindow` (it keeps the AgentEntry map, widget, polling, guardrails,
  agent_reply). Caller still owns awaiting terminal state via its 1s tick +
  `fs.watch` (`pollAgentState`/`finishAgent`) — not moved, since that's bound to
  the widget/lifecycle. pi-chain will implement its own simpler wait loop on the
  same `stateFile` contract.
- Verified live (fresh `pi -p` driving launch_agent): (a) plain blocking spawn →
  `HELLO_FROM_CHILD` returned inline; (b) persona injection via `system_prompt`
  → child replied "Arrr…". Caught + fixed a missing `sanitizeAgentName` import
  during testing.
- NOTE for pi-chain: confirmed pi resolves relative imports between extension
  files, and a `lib/` subdir (no `index.ts`) is NOT auto-loaded as its own
  extension — so shared modules under `extensions/lib/` are safe.

### [x] 2. Build `pi-chain.ts` skeleton  ✅ DONE
- Loads `agent-chain.yaml` from `~/.config/pi/agents/` and `./.pi/agents/`
  (first file wins on name clash); validates `kind: chain` + steps.
- YAML parsing via a self-contained `lib/mini-yaml.ts` (pi's bundled `yaml`
  isn't resolvable from an extension and the repo avoids a node_modules install
  step). Supports maps, block/flow sequences, quoted + `|` block scalars
  (blank-line-preserving). Unit-tested with node's TS type-stripping.
- Commands `/chain` (set active, with picker), `/chain-list`, `/chain-reset`.
- `run_chain(chain?, input)` tool registered (top-level only; PI_SUBAGENT bails).

### [x] 3. Implement the deterministic pipe (`run_chain`)  ✅ DONE
- Sequential loop over steps via `spawnAgentWindow` + a per-step wait loop on the
  shared `{tmpBase}.state.json` contract (fs.watch + 1s poll; pane-death = done).
- `$INPUT`/`$ORIGINAL` single-pass substitution (`fillTemplate`).
- On `done`: capture output, pipe to next step's `$INPUT`. On `error` (or missing
  agent def / spawn failure): halt, never spawn the next step, return which step
  failed. Final step output returned as the tool result.
- Verified live: `echo-chain` (uppercase → exclaim) on "hello world" →
  "HELLO WORLD!!!" (proves piping); `broken-chain` halted at step 1 with a clear
  error and never ran step 2. Step subagents + IPC files cleaned up.
- Guardrails: a paused step surfaces a one-time notification pointing at its
  window (no inline approval UI in the chain — resolve in-window, run continues).

### [x] 4. Flow widget  ✅ DONE (loads; pending a visual check)
- Vertical pipeline card (scales better than horizontal arrows): title with
  `running N/total` / `done` / `failed at N`, one row per step with
  `✓/●/⚠/✗/○` glyph + elapsed + ↑/↓/$ + live window target, `│` connectors,
  and a note line for stop/error reasons. Modeled on the coms-bus widget.
- Only verified to load cleanly so far — eyeball it on a live `/reload` run.

### [x] 4.5. Persistent teams (`persist` / `clearContext`)  ✅ DONE (pending restart-eyeball)
Generalized a chain from a one-shot pipe into a (possibly) warm team you can feed
many topics through. No new IPC — reuses the `agent-spawn` inbox→state contract.
- **Schema:** `ChainDef.persist` (default false) + `ChainDef.clearContext`
  (default true); per-step `StepDef.clearContext` override. Parsed in
  `loadChains` (mini-yaml gives proper booleans).
- **`lib/agent-spawn.ts`:** added `AgentState.seq`; the child bumps a monotonic
  `seq` on every `agent_end`. Persistent members stay status `running`, so the
  orchestrator detects per-topic completion by watching `seq` advance past the
  value it held before sending (turn_start/turn_end writes omit `seq`).
- **`pi-chain.ts`:** `liveTeam` registry (one warm team, keyed by chain name) +
  `killMember`/`teardownLiveTeam`. `runPersistentStep` spawns once (warm-up task
  = first topic), then feeds later topics via the inbox file; drops the member on
  pane-death or cancel (cancel could leave a stale `seq` → respawn clean).
  `run_chain` routes each step ephemeral (`runStep`) vs persistent; tears the
  team down after the run unless `persist`.
- **Commands:** `/chain-down` (shut down a warm team); teardown also on chain
  error (when !persist), `session_start`, `session_shutdown`.
- **Also folded in here:** `renderResult` must return a `Text` component, not a
  raw string (a string throws `child.render is not a function`); the flow widget
  now auto-dismisses 10s after a terminal state (`scheduleDismiss`) with
  `/chain-show` to re-display and `/chain-reset` to clear.
- **Test chain:** `pitch-lab-live` (`persist:true`, reviewer `clearContext:false`).

### [ ] 5. Phase 3 wiring — `dp-research` chain
- Write `~/.config/pi/agents/dp-synthesizer.md` (takes raw research → structured
  KB entry; writes the file; summary / key findings / open questions).
- Add the `dp-research` entry to `agent-chain.yaml`.
- End-to-end test: `run_chain("dp-research", "<topic>")`.

### [x] 6. Docs + CLAUDE.md  ✅ DONE
- Wrote `config/pi/extensions/pi-chain.md` design doc (mirrors tmux-subagent.md /
  coms-bus.md style; covers the persist × clearContext model, `seq` completion,
  the live-team registry, and gotchas).
- Added a `pi-chain.ts` row to the CLAUDE.md config table (covers the tool, both
  axes, the inbox/`seq` mechanism, and all commands).
- TODO: update `AGENT_PLAN.md` file-layout checkmarks (not yet done).

### [ ] 7. (Later) `kind: team` declarative support + composition / nesting
- **Not started.** Teams today are imperative only (`launch_agent(team:...)` in
  `tmux-subagent.ts` + `coms-bus.ts`). `loadChains` skips any non-`kind:chain`
  block, so a `kind: team` entry in `agent-chain.yaml` is currently ignored.
- Add a team loader (`members: [...]`) + a `run_team` dispatch.
- Allow a chain step to reference another `chain:` or `team:` unit — this is
  where the `kind:` discriminator pays off (`run_chain` dispatches to `run_team`
  for a team-typed step, gathers, then pipes the result onward).

---

## Reuse / don't-duplicate notes

- One link implementation, two callers: the `launch_agent` tool and the
  `run_chain` loop. No copy-paste of spawn/IPC (avoid drift — the plan's
  explicit anti-goal).
- `StringEnum` from `@earendil-works/pi-ai` for tool enum params (Google-model
  compatibility) — same as tmux-subagent.
- `os.tmpdir()` ≠ `/tmp` on macOS — IPC files live under `$TMPDIR`.
- Subagents launch `--no-skills` unless their agent def lists `skills:`.

## Commit hygiene

- Scope: `pi`.
- Logical commits: (1) extract shared primitive, (2) pi-chain skeleton + run_chain,
  (3) flow widget, (4) persistent teams (`persist`/`clearContext` + `seq` in
  agent-spawn) incl. the `renderResult` Text fix and auto-dismiss/`/chain-show`,
  (5) dp-synthesizer + dp-research chain wiring, (6) docs (pi-chain.md + CLAUDE.md).
- **Do not commit until the user says they're satisfied.**

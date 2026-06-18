# Pi Agent Plan

## Guiding Principles

- **Never headless** — every agent runs in a real tmux window, always observable and interruptible
- **Knowledge base** lives at `/Users/charsmith/Documents/the_vault/dp-knowledge-base/`
- **Agent definitions** live in `.pi/agents/<name>.md` (YAML frontmatter + system prompt body)
- **Chain before team** — build with real use cases first
- **Data platform research agent is the priority** — everything else serves it

---

## Agent Definition Format

All agents are defined as markdown files with YAML frontmatter:

```
.pi/agents/<name>.md
```

```markdown
---
name: agent-name
description: One-line description of what this agent does
tools: read,write,bash,grep,find,ls
---
System prompt body here...
```

Scanned from: `agents/`, `.claude/agents/`, `.pi/agents/` (in order, first-seen wins).

---

## Phase 1 — Data Platform Research Agent (Priority)

### 1a. Knowledge base structure

Directory: `/Users/charsmith/Documents/the_vault/dp-knowledge-base/`

```
dp-knowledge-base/
  README.md              — index of what's been researched
  metacat/               — Metacat API, clients, partition discovery, etc.
  iceberg/               — Iceberg table format, snapshots, manifests
  spark/                 — Spark integration, connectors
  flink/                 — Flink integration
  lineage/               — Data lineage systems
  ...
```

Agent always reads README.md before researching. Agent always writes findings after researching.

### 1b. Agent definition: `dp-researcher.md`

File: `~/.config/pi/agents/dp-researcher.md` (or project-local `.pi/agents/`)

System prompt covers:
- Check knowledge base before starting (read README.md + relevant subdirectory)
- Available CLIs: `og` (Sourcegraph), `cy` (Metacat/data platform), `ta` (team/repo activity)
- Research methodology: search code → read source → check metadata → record findings
- Output format: always write a markdown file back to the knowledge base
- Citation format: include repo paths, file paths, table names, team names as sources

### 1c. Test standalone (no chain needed yet)

Launch via existing `launch_agent` tool:
```
launch_agent: "Research how Metacat handles partition discovery. Check the knowledge base first."
model: claude-sonnet-4-6
```

This works today with `tmux-subagent.ts`. No new code needed for Phase 1.

**Goal:** iterate on the agent definition until the research quality is good.

---

## Phase 2 — Agent Chain (`pi-chain.ts`)  ✅ DONE (+ persistent teams)

> **Status:** built and verified. `run_chain` tool, YAML chains, and the flow
> widget all work. Extended beyond the original one-shot design with **persistent
> teams**: `persist` (keep agents warm between runs) and `clearContext` (fresh
> per-topic vs. context accumulated across topics) — a `persist:true` +
> `clearContext:false` chain is a *linear persistent team*. Per-topic completion
> is detected via a monotonic `seq` counter in `lib/agent-spawn.ts`. See
> `CHAIN_BUILD_PLAN.md` (Steps 1–4 + 4.5 + 6) and the `pi-chain.md` design doc.
> Remaining: Phase 3 (dp-synthesizer + real dp-research chain).

### Architecture

Orchestrator lives in the parent pi window. Each chain step runs as a real tmux window
via the same file-based IPC as `tmux-subagent.ts`. Steps execute sequentially:

1. Step N spawns a tmux window with the agent's system prompt + resolved prompt template
2. Orchestrator watches `{tmpBase}.state.json` for `done` / `error`
3. On `done`: extracts output, marks card ✓, feeds output as `$INPUT` to step N+1
4. On `error`: halts chain, shows which step failed

### Flow widget (in parent window)

```
┌──────────────────┐       ┌──────────────────┐       ┌──────────────────┐
│  DP Researcher   │       │   Synthesizer    │       │     Writer       │
│  ● running  23s  │ ──▶  │  ○ pending        │ ──▶  │  ○ pending       │
│  [0:2]           │       │                  │       │                  │
│  Searching meta… │       │  —               │       │  —               │
└──────────────────┘       └──────────────────┘       └──────────────────┘
```

- Running card: accent color, live tmux window target, live last-output-line
- Done card: success color, ✓, elapsed time
- Error card: error color, ✗, halts chain
- Arrows between cards (` ──▶ `)

### Tmux window layout during a 3-step chain

```
[0:1] pi (parent/chain orchestrator)
[0:2] dp-researcher  ●     (opens when step 1 starts)
[0:3] dp-synthesizer       (opens when step 2 starts, after step 1 done)
```

You can `Ctrl+b 2` to watch a running step. `agent_reply` can steer a running step.
Finished step windows close automatically (or kept — TBD by preference).

### Chain definition format

File: `.pi/agents/agent-chain.yaml`

```yaml
dp-research:
  description: "Research a data platform topic end-to-end"
  steps:
    - agent: dp-researcher
      prompt: "$INPUT"
    - agent: dp-synthesizer
      prompt: "Synthesize these raw findings into structured notes:\n\n$INPUT"

feature-build:
  description: "Plan and implement a feature"
  steps:
    - agent: planner
      prompt: "$INPUT"
    - agent: builder
      prompt: "Implement this plan:\n\n$INPUT"
    - agent: reviewer
      prompt: "Review this implementation:\n\n$INPUT\n\nOriginal goal: $ORIGINAL"
```

`$INPUT` = output from previous step (or original user prompt for step 1)
`$ORIGINAL` = always the user's original prompt

### Commands

- `/chain` — select active chain from a pick list
- `/chain-list` — list all defined chains with their steps
- `/chain-reset` — clear step states, reset to pending (same chain)

### Tool: `run_chain`

The parent agent has `run_chain` available alongside its normal tools. It decides
when to invoke it based on the user's request — trivial questions answered directly,
real work goes through the chain.

### IPC reuse

`pi-chain.ts` reuses the window-spawning and file-based IPC from `tmux-subagent.ts`
rather than duplicating it. Options:
- **Extract shared utility**: `tmux-agent-spawn.ts` — a module both import
- **Extend tmux-subagent**: add chain mode to the existing extension (more complex)
- **Duplicate + adapt**: simplest to ship but creates drift (avoid)

Preferred: extract shared spawn/IPC utility.

---

## Phase 3 — DP Research Chain

Wire the research agent into a chain with a synthesizer:

### `dp-synthesizer.md`

Takes raw research output (tool calls, notes, quotes from code) and produces:
- Clean structured markdown suitable for the knowledge base
- Summary section
- Key findings
- Open questions / follow-up research areas
- Writes the final file to the knowledge base

### `agent-chain.yaml` entry: `dp-research`

```yaml
dp-research:
  description: "Research a data platform topic and record structured findings"
  steps:
    - agent: dp-researcher
      prompt: "$INPUT"
    - agent: dp-synthesizer
      prompt: "Synthesize these research findings into a structured knowledge base entry:\n\n$INPUT\n\nOriginal question: $ORIGINAL"
```

---

## Phase 4 — Agent Team

> **Status:** the *messaging* substrate is built — `coms-bus.ts` (peer-to-peer
> bus) + `tmux-subagent.ts`'s `team` launch mode give persistent, addressable
> team members **imperatively** (`launch_agent(team:...)`). Still **not done**:
> declarative teams from a `teams.yaml` (`kind: team` + `members:`) and a
> `run_team` dispatch / grid dashboard. `pi-chain.ts`'s `loadChains` deliberately
> ignores any non-`kind:chain` block, so the `kind:` discriminator seam is in
> place for this. Tracked as Step 7 in `CHAIN_BUILD_PLAN.md`.

Grid dashboard. Dispatcher-only orchestrator. Good for parallel work where order
doesn't matter (e.g., research multiple topics simultaneously, or different specialists
working on different parts of a codebase).

Teams defined in `.pi/agents/teams.yaml`:

```yaml
dp-research-team:
  - dp-researcher
  - dp-synthesizer
  - dp-reviewer

feature-team:
  - planner
  - builder
  - reviewer
  - tester
```

Grid widget (2–3 columns, auto-sized by team size):

```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│  DP Researcher   │  │  DP Synthesizer  │  │  DP Reviewer     │
│  ✓ done   41s    │  │  ● running  12s  │  │  ○ idle          │
│  [###--] 60%     │  │  [#----] 20%     │  │                  │
│  metacat/client… │  │  Structuring…    │  │  —               │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

---

## Phase 5 — DP Research Agent Maturity

Once the agent is running regularly, evolve it:

- **Topic index**: `README.md` in knowledge base auto-updated with links to all notes
- **Confidence tracking**: agent notes when findings are confirmed vs. inferred
- **Version awareness**: notes include dates; agent can flag when to re-research stale topics
- **Cross-references**: agent links related topics (e.g., metacat ↔ iceberg ↔ lineage)
- **Research queue**: a `TODO.md` in knowledge base — things discovered but not yet researched
- Possible: agent team where `dp-researcher` does the digging and `dp-knowledge-curator`
  maintains the index and cross-references

---

## File Layout (when done)

```
~/.config/pi/
  extensions/
    catppuccin-footer.ts      ✓ done
    tmux-pi-state.ts          ✓ done
    tmux-subagent.ts          ✓ done
    tmux-window-name.ts       ✓ done
    coms-bus.ts               ✓ done (messaging substrate; imperative teams)
    pi-chain.ts               ✓ done (phase 2 + persistent teams)
    pi-chain.md               ✓ done (design doc)
    lib/agent-spawn.ts        ✓ done (shared spawn/IPC primitive)
    lib/mini-yaml.ts          ✓ done (YAML subset parser)
    pi-team.ts                phase 4 — declarative teams.yaml / grid (not started)
  agents/
    dp-researcher.md          ✓ done (phase 1)
    dp-synthesizer.md         phase 3 (not started)
    agent-chain.yaml          ✓ done (phase 2; incl. pitch-lab + pitch-lab-live)
    teams.yaml                phase 4 (not started)
  skills/ → (gitignored, symlinks to other repos)
  settings.json
  guardrails.json
```

---

## Immediate Next Actions

1. ~~Create `~/.config/pi/agents/dp-researcher.md`~~ ✅ done
2. ~~Create knowledge base structure~~ ✅ done
3. ~~Test standalone via `launch_agent`~~ ✅ done
4. ~~Extract IPC utility (`lib/agent-spawn.ts`)~~ ✅ done
5. ~~Build `pi-chain.ts` — flow widget + chain orchestration~~ ✅ done (+ persistent teams)
6. **Restart-and-eyeball** the persistent-team work (`runPersistentStep`/`seq`,
   `/chain-down`, `pitch-lab-live`) — implemented after the last live run.
7. **Wire dp-research chain** — `agent-chain.yaml` `dp-research` entry + `dp-synthesizer.md` (Phase 3).
8. **(Later) Declarative teams** — `kind: team` loader + `run_team` (Phase 4 / CHAIN_BUILD_PLAN Step 7).

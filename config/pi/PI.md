# Pi Agent System

Single reference for how the agent system is built, how to use it, and what's next.
Replaces: `AGENT_PLAN.md`, `CHAIN_BUILD_PLAN.md`, `TEAM_DESIGN_PLAN.md`, `TEAM_PROTOCOL.md`.

---

## Architecture Overview

Three layers, each building on the one below:

```
┌─────────────────────────────────────────────────────┐
│  CATALOG  — authoring + discovery                   │
│  catalog.ts: catalog_list/read/validate,            │
│              agent_author, charter_author           │
├──────────────────────┬──────────────────────────────┤
│  CHAIN               │  TEAM                        │
│  pi-chain.ts         │  tmux-subagent.ts             │
│  run_chain           │  run_charter (kind: team)    │
│  sequential pipe     │  hub-spoke coordinator       │
├──────────────────────┴──────────────────────────────┤
│  PRIMITIVES                                         │
│  lib/agent-spawn.ts  — spawn one agent window       │
│  tmux-subagent.ts    — launch_agent / agent_reply   │
│  coms-bus.ts         — peer-to-peer messaging       │
│  lib/mini-yaml.ts    — YAML subset parser           │
│  lib/catalog-loader.ts — shared catalog reader      │
└─────────────────────────────────────────────────────┘
```

---

## File Layout

```
~/.config/pi/
  agents/
    <name>.md             agent definitions (frontmatter + system prompt)
    agent-chain.yaml      legacy chain definitions (kind: chain only)
  charters/
    <name>.yaml           chain or team charters (kind: chain | kind: team)
  extensions/
    pi-chain.ts           run_chain tool + flow widget
    tmux-subagent.ts      launch_agent, agent_reply, run_charter tools
    coms-bus.ts           coms_send, coms_broadcast, coms_poll tools
    catalog.ts            catalog_list/read/validate, agent_author, charter_author
    tmux-pi-state.ts      tmux window pill color (green=running, gray=idle)
    tmux-window-name.ts   renames tmux window to working directory basename
    catppuccin-footer.ts  pi footer in catppuccin mocha style
    lib/
      agent-spawn.ts      shared spawn/IPC primitive (used by pi-chain + tmux-subagent)
      catalog-loader.ts   shared catalog reader (used by pi-chain + catalog)
      mini-yaml.ts        YAML subset parser
  skills/                 gitignored; symlinks to skill repos (og, cy, ta, wp, etc.)
  agent-teams.json        config: workdir for team output (default ~/code/agent-teams)
  settings.json           pi settings
  trust.json              trusted paths

~/code/agent-teams/       team run work directories (output.md lives here)
```

---

## Agents

An agent is a `.md` file with YAML frontmatter + a system prompt body.

```markdown
---
name: my-agent
description: One-line description shown in the catalog
tools: read,write,bash          # optional: restrict tools
skills: og,cy                   # optional: skill files to load
spawn_agents: true              # optional: allow this agent to spawn subagents
---
System prompt body here.
```

**Authoring:** use `agent_author(name, content)` (validates before writing, backs up existing).

**Live agents:**
| Agent | Description |
|-------|-------------|
| `dp-researcher` | Researches Netflix data platform services via og/cy/ta/wp; reads/writes the KB at `~/Documents/the_vault/dp-knowledge-base/` |
| `research-lead` | Coordinator for `research-team`; decomposes task → dispatches structured subtasks → routes through critic → reconciles → writes `output.md` |
| `analyst` | Grounds findings in real sources; returns structured Claims/Evidence/Confidence/Open-Questions |
| `critic` | Reviews analyst findings before synthesis; flags unsupported claims, gaps, contradictions |

---

## Chains

A chain is a declared sequential pipeline. Each step's output becomes the next step's `$INPUT`. `$ORIGINAL` is always the original user input.

### Declaration

Chains live in `~/.config/pi/agents/agent-chain.yaml` (legacy) or `~/.config/pi/charters/<name>.yaml`.

```yaml
kind: chain
description: "Turn an idea into a tagline, then critique it"
steps:
  - system_prompt: "You are a brand strategist. Output ONE tagline under 10 words."
    model: anthropic/claude-haiku-4-5
    prompt: "$INPUT"
  - system_prompt: "You are a blunt critic. Reply with exactly 2 sentences: praise, then criticism."
    model: anthropic/claude-haiku-4-5
    prompt: |
      Tagline: $INPUT
      (Original idea: $ORIGINAL)
```

**Step fields:** `agent` (agent def name) or `system_prompt` (inline); `model` (optional); `prompt` (template); `clearContext` (per-step override).

**Chain fields:**
- `persist` (default `false`) — keep agents alive between `run_chain` calls
- `clearContext` (default `true`) — fresh context per topic; `false` = agents accumulate context across topics

### Tool: `run_charter` (chains)

```
run_charter(charter, input, budget?)
```

The unified entry point for both chains and teams. For `kind: chain`, it dispatches internally to `run_chain`. Each step runs in its own tmux window. A flow widget above the editor shows live step status (`○ ● ✓ ✗`). Auto-dismisses 10s after completion.

`run_chain(chain?, input)` still exists as a lower-level tool and accepts the chain name or uses the active chain set via `/chain`.

### Commands
| Command | Action |
|---------|--------|
| `/ag:chain` | Select active chain from a picker |
| `/ag:chain-list` | List all declared chains |
| `/ag:chain-show` | Re-display the flow widget |
| `/ag:chain-reset` | Reset step states to pending |
| `/ag:chain-down` | Shut down a warm persistent team |

### Live chains
| Chain | Description |
|-------|-------------|
| `pitch-lab` | One-shot: idea → tagline (Haiku) → critique (Haiku) |
| `pitch-lab-live` | Persistent variant: reviewer remembers prior taglines across runs |

---

## Teams

A team is a hub-spoke group of agents. The coordinator receives the task, delegates to specialists via the coms-bus, and writes `output.md` when done. The parent session gets a follow-up with the result.

### Declaration

Teams live in `~/.config/pi/charters/<name>.yaml`.

```yaml
kind: team
description: "A research lead coordinates an analyst to research any topic"
topology: hub-spoke
entry_point: research-lead
guardrail: auto

members:
  - agent: research-lead
    role: coordinator
    description: "Delegates tasks and synthesizes findings into output.md"

  - agent: analyst
    role: specialist
    description: "Researches assigned topics and reports findings back"
    reports_to: research-lead
```

**Fields:**
- `topology` — `hub-spoke` (only topology currently implemented)
- `entry_point` — which agent is the coordinator (falls back to first member with `role: coordinator`)
- `guardrail` — `confirm` (default, prompts before spawning) | `auto` (no prompt) | `never` (blocks launch)
- `persist` — keep agents alive between runs (default `false`)

### Tool: `run_charter` (teams)

```
run_charter(charter, input, budget?)
```

The same tool used for chains. For `kind: team`, spawns all members and returns immediately — the coordinator delivers a follow-up when done. Default budget cap: $20.

### How teams work at runtime

1. `run_charter` creates a work dir: `~/code/agent-teams/<team>/<YYYYMMDD-HHMMSS-task-slug>/`
2. Writes `input.md` with the task text
3. Spawns workers first, then the coordinator
4. Workers: "wait for instructions on coms-bus project `<project>`"
5. Coordinator: "delegate, synthesize, write your report to `<workdir>/output.md`"
6. When the coordinator writes `output.md` and exits, the parent gets a follow-up
7. `/ag:team-down <project>` or `team_down(project)` tears down any remaining members

### Coordinator/worker communication

Agents communicate via the coms-bus (`coms_send`, `coms_broadcast`, `coms_poll`). The coordinator uses `coms_list` to discover team members, sends tasks via `coms_send`, and receives replies as follow-up turns (no polling needed — replies are async).

### Live teams
| Charter | Description |
|---------|-------------|
| `research-team` | `research-lead` (coordinator) + `analyst` (grounded specialist) + `critic` (verifier) |

---

## Catalog

The catalog is derived from the filesystem on demand — no index file.

- **Agents:** `~/.config/pi/agents/*.md`
- **Chains + Teams:** `~/.config/pi/charters/*.yaml` + legacy `agent-chain.yaml`

### Tools
| Tool | Description |
|------|-------------|
| `catalog_list(kind?)` | List agents, chains, teams (optional filter: `agent`/`chain`/`team`) |
| `catalog_read(name)` | Return full content (agent `.md` or charter YAML) for one entry |
| `catalog_validate(input)` | Validate a charter name or raw YAML string; returns structured errors |
| `agent_author(name, content)` | Write an agent `.md`; validates frontmatter; backs up existing |
| `charter_author(name, yaml)` | Write a charter YAML to `~/.config/pi/charters/`; validates before writing |

### Command: `/ag:catalog [filter]`

Shows all catalog entries grouped by kind. `/ag:catalog agents`, `/ag:catalog chains`, `/ag:catalog teams`. `/ag:catalog <name>` shows full detail for one entry.

---

## Infrastructure

How the runtime is actually structured and what the gaps are, especially for dynamic team formation.

### What the runtime does today

```
run_charter(team)
  ├─ creates workDir/<charter>/<timestamp-slug>/
  ├─ writes input.md, manifest.json, blackboard.md, task-ledger.json   ← NEW
  ├─ spawns workers first (persistent coms-bus members, warm-up task)
  ├─ spawns coordinator last (persistent, PI_COORDINATOR=1, PI_WORK_DIR set)
  │     system prompt = agent.md body + coordinator instructions (blackboard/ledger paths)
  │     task        = dynamic instructions OR coms-bus instructions (based on spawn_agents + workers)
  └─ polls pollAgentState every 1s
        on status=="completed": reads output.md → follow-up + updates manifest.json + writes info.md
```

**Formation modes** (auto-detected by `run_charter`):

| Condition | Mode | Coordinator instructions |
|---|---|---|
| `spawn_agents: true` in agent def AND no pre-declared workers | **Dynamic** | Use `launch_agent` (blocking) to spawn domain-specific specialists at runtime |
| Pre-declared workers in charter | **Static (coms-bus)** | Use `coms_list` / `coms_send`; workers are already alive on the bus |

**Work directory files** (all per-run, under `~/code/agent-teams/<charter>/<run>/`):

| File | Written by | Purpose |
|---|---|---|
| `input.md` | runtime at start | Original task text |
| `manifest.json` | runtime at start+end | Machine-readable run record (charter, task, members, timing, cost) |
| `blackboard.md` | coordinator (append) | Ephemeral shared state: task graph, status updates, claim notes |
| `task-ledger.json` | coordinator (r/w) | Structured subtask tracking: id, domain, status, depends |
| `output.md` | coordinator (last) | Final report; existence signals completion |
| `info.md` | runtime at end | Human-readable cost/timing table |

### Key infrastructure gaps (remaining)

**1. Budget governance for dynamic spawns**
When a coordinator with `spawn_agents: true` calls `launch_agent`, those sub-specialists run in the coordinator's pi session. Their costs are NOT visible to the top-level budget tracking — the global budget check only sees the coordinator's own token cost. Fix requires sub-specialists to write their costs to a shared file the top-level session reads.

**2. Coordinator done signal**
Completion is detected by polling for `output.md` existence on every `agent_end` event. This means the coordinator must write output.md as its last action. A more robust approach is an explicit `coordinator_done()` tool that atomically signals completion + hands off the summary. Currently item #2 in roadmap.

**3. No max-rounds enforcement**
Coordinator loops (e.g. retry after critic challenge) have no hard stop. A global `max_rounds` field in the charter schema + enforcement in the runtime would prevent runaway teams. Not in charter schema yet.

**4. No persistent knowledge store provenance**
The `dp-researcher` KB writes lack staleness/confidence signals at the infra level. A future `knowledge-write` tool (vs. raw file write) would enforce provenance metadata and expiry.

**5. Run trace richness**
`manifest.json` captures start/end and per-agent cost, but not: which subtasks ran, per-subtask timing, contradiction events, or critic challenge counts. A richer trace is needed for the retrospective agent to do useful credit assignment.

---

## What's Next

In priority order:

### 1. `dp-research` chain (immediate practical value)

Wire the existing `dp-researcher` into a chain with a new `dp-synthesizer` agent.

**`dp-synthesizer.md`** — takes raw researcher output, produces a clean structured KB entry (summary, key findings, open questions, citations). Writes the file to the knowledge base. Uses the same KB path as `dp-researcher`.

**Chain entry in `agent-chain.yaml`:**
```yaml
dp-research:
  kind: chain
  description: "Research a data platform topic and record structured findings"
  steps:
    - agent: dp-researcher
      prompt: "$INPUT"
    - agent: dp-synthesizer
      prompt: |
        Synthesize these findings into a structured KB entry:

        $INPUT

        Original question: $ORIGINAL
```

### 2. `coordinator_done` signal

Currently the coordinator writes `output.md` via the `write` tool and exits naturally. This works, but there's no explicit "I'm done" signal — the parent detects completion by pane exit, which can be noisy if the coordinator exits for other reasons.

Add a `coordinator_done(summary?)` tool (available only inside coordinator sessions, i.e. `PI_COORDINATOR=1`). It: writes a summary to `output.md` if provided, flips the state file to `completed`, and exits cleanly. The parent reacts to `completed` with a follow-up carrying the output.

### 3. Run manifests (foundation for retro)

When `run_charter` runs a team or chain, write a manifest to:
```
~/.config/pi/runs/<charter>/<timestamp>_<run-id>_manifest.json
```

Captures: charter name, kind, task, started/ended, outcome, per-agent timing + token usage, session log paths. Also append a one-line summary to `performance.jsonl` for cross-run trend analysis.

This is the prerequisite for the retrospective feature.

### 4. Retrospective agent (future)

A `retro-agent` that reads a run manifest + session logs and produces a structured report with concrete suggestions for improving the charter and agent system prompts. Suggestions are machine-parseable diffs that `charter_apply` can apply.

Not started. Needs run manifests (#3) first.

# Team Design Plan — Authoring + Catalog + Retrospective

Companion to `AGENT_PLAN.md` and `CHAIN_BUILD_PLAN.md`. This document designs two
major features on top of the existing pi primitive stack: (1) a unified catalog
with conversational authoring tooling, and (2) a post-run retrospective + charter
improvement loop. Read those plans first for context.

**Status: Design only. No implementation started.**

---

## 1. Unifying Mental Model

Before designing the features, we need a coherent mental model of what this system
*is*. Right now the three building blocks have slightly mismatched vocabulary and
live in separate files. These features only work cleanly if we agree on the
conceptual stack first.

### 1.1 The Three Layers of AI Work

```
┌─────────────────────────────────────────────────────────────┐
│  TEAM / CHAIN  — multi-agent compositions                    │
│  "A named, reusable structure of agents working together"   │
├─────────────────────────────────────────────────────────────┤
│  AGENT  — single AI persona with skills + tools             │
│  "A named, reusable role with a system prompt"              │
├─────────────────────────────────────────────────────────────┤
│  PRIMITIVE  — spawn/IPC/messaging substrate                 │
│  tmux-subagent.ts · coms-bus.ts · agent-spawn.ts            │
└─────────────────────────────────────────────────────────────┘
```

The primitives are already stable and well-designed. Agents are already well-defined
as `.md` files. The gap is that teams and chains have grown organically into two
separate concepts (different files, different tools, different UIs) when they are
really two *topologies* of the same thing: a named multi-agent composition.

### 1.2 Normalized Vocabulary

These terms are used consistently throughout this document:

| Term | Definition |
|------|------------|
| **Agent def** | A `.md` file in `~/.config/pi/agents/<name>.md`. Persona, skills, tools, system prompt. The atomic unit. |
| **Charter** | The complete, declarative definition of a team or chain — YAML block(s) in `agent-chain.yaml` plus all referenced agent `.md` files. "The spec." |
| **Chain** | A charter with `kind: chain`. Linear pipeline. Sequential, deterministic, one output feeds the next. |
| **Team** | A charter with `kind: team`. Concurrent, coordinator-driven. Agents communicate via coms-bus. |
| **Run** | One execution of a charter against a task. Has a start time, end time, outcome, and a set of run artifacts. |
| **Run artifact** | Everything written to disk during and after a run: session `.jsonl` logs, coms-bus messages, run manifest, retro output. |
| **Run manifest** | A JSON file written at run start and updated at run end. The "receipt" for one run — who ran, when, how long, what happened. |
| **Catalog** | The union of all agent defs + all charter YAML blocks. What pi knows about right now. |
| **Retro** | A post-run analysis of a run's artifacts, producing structured suggestions for improving the charter. |
| **Charter patch** | A concrete, user-reviewable suggestion from a retro: a diff to a YAML block and/or one or more agent `.md` files. |

### 1.3 How the New Features Fit In

```
USER INTENT
    │
    ▼
[Authoring] ──────────────► CATALOG (agent defs + charter YAML)
                                  │
                           ┌──────┴──────┐
                           ▼             ▼
                        CHAIN          TEAM
                        (pi-chain.ts)  (run_team — new)
                           │             │
                           └──────┬──────┘
                                  │  Run Artifacts
                                  ▼
                           [Retrospective] ──► Charter Patches
                                                    │
                                                    ▼
                                             CATALOG (updated)
```

Authoring feeds the catalog. The catalog drives execution. Execution produces run
artifacts. Retrospective reads artifacts and proposes patches. Patches update the
catalog. The loop closes. This is the flywheel.

---

## 2. Feature 1: Authoring + Catalog

### 2.1 Catalog Architecture

**Decision: derive the catalog from the filesystem; no separate index file.**

A separate index (e.g. `catalog.json`) would always risk drift from the source
files. The catalog is cheap to rebuild: scan `~/.config/pi/agents/*.md` for agent
defs, parse `agent-chain.yaml` for chain/team blocks. This already happens in
`loadChains()` in `pi-chain.ts` (for chains) and implicitly in `loadAgentDef()`
in `agent-spawn.ts`. A new `catalog.ts` extension unifies both reads.

The three components of the catalog and their on-disk locations:

```
~/.config/pi/agents/
  <name>.md               ← agent def (frontmatter + system prompt)
  agent-chain.yaml        ← all chain + team charters (unified YAML file)

~/.config/pi/runs/
  <charter-name>/
    <timestamp>_<id>_manifest.json   ← per-run manifest
    performance.jsonl                ← accumulated run summaries (one line/run)
```

Why keep chains and teams in the same `agent-chain.yaml` instead of splitting
them into `chains.yaml` and `teams.yaml`? Because the `kind:` discriminator was
designed from day one for exactly this reason (see CHAIN_BUILD_PLAN.md framing
section). Splitting now creates two places to check, two parsers to maintain, and
prevents the nesting story (a chain step that delegates to a team). Keep it one
file.

### 2.2 Charter YAML Schema — `kind: team`

The existing `kind: chain` schema is proven. The new `kind: team` must be additive,
not a redesign. Here is the proposed schema:

```yaml
# ─── Team charter ────────────────────────────────────────────────────────────
dp-research-team:
  kind: team
  description: "Parallel specialists researching a data platform topic under a lead coordinator"
  guardrail: confirm          # confirm | auto | never  (default: confirm)
  persist: true               # keep agents warm between run_team calls
  topology: hub-spoke         # hub-spoke | mesh | chain | custom
  entry_point: dp-lead        # agent that receives the initial task and drives the run

  members:
    - agent: dp-lead          # references ~/.config/pi/agents/dp-lead.md
      role: coordinator
      description: "Receives the task, delegates to specialists, synthesizes results"

    - agent: dp-researcher
      role: specialist
      description: "Deep-dives on assigned services"
      reports_to: dp-lead     # coms-bus routing hint; who this agent should address replies to

    - agent: dp-synthesizer
      role: specialist
      description: "Takes researcher findings and writes structured KB entries"
      reports_to: dp-lead

  # Optional: explicit communication patterns for retro analysis and routing hints
  comms:
    - label: delegation       # human-readable label used in retro communication graph
      from: dp-lead
      to: "*"                 # wildcard: any team member
    - label: findings
      from: dp-researcher
      to: dp-lead
    - label: synthesis
      from: dp-synthesizer
      to: dp-lead
```

**Topology values and what they imply:**

| Topology | Shape | Entry Point | Completion Signal |
|----------|-------|-------------|-------------------|
| `hub-spoke` | One coordinator dispatches to N specialists | `entry_point` agent | Coordinator declares done |
| `mesh` | All agents can message any other | Any (all see initial task) | All agents quiesce |
| `chain` | Like `kind: chain` but declared as a team | First member | Last member finishes |
| `custom` | No routing rules — fully manual via coms-bus | Any | Coordinator declared in `entry_point` |

For the initial implementation, build `hub-spoke` first. It covers 80% of real
use cases (CEO + specialists, lead + researchers) and has a clear completion
semantics. `mesh` is the risky one — hardest to reason about, most likely to
deadlock — defer until hub-spoke is battle-tested.

### 2.3 Authoring Tools

**Decision: structured tools over raw file writes, but thin wrappers — not a wizard.**

Claude already has file-write access. The authoring tools exist to add three things
raw writes don't provide: (1) schema validation before writing, (2) atomic
transactions (don't partially write a team where referenced agents don't exist yet),
and (3) a consistent entry point for the retro system to track changes.

Proposed tools in a new `catalog.ts` extension:

#### `agent_author(name, content)`
Writes `~/.config/pi/agents/<name>.md`. Validates:
- Frontmatter is parseable (reuse `mini-yaml.ts`)
- Required fields present: `name`, `description`
- No existing agent with that name (or `overwrite: true` flag)
- If the agent def references `skills:`, those skills exist

Returns: `{ path, warnings[] }` — warnings for missing optional fields, not errors.

#### `agent_update(name, field, value)`
Targeted patch to a single frontmatter field or to the system prompt body. Uses
string replacement, not full rewrite. Backs up to `<name>.md.bak.<timestamp>`
before writing. This is the tool the retro flow uses for per-agent improvement
suggestions.

#### `charter_author(name, yaml_block)`
Appends or replaces a named block in `agent-chain.yaml`. Validates:
- Valid YAML structure via `mini-yaml.ts`
- `kind` is one of `chain`, `team`
- For `kind: team`: `entry_point` exists in `members`, all `agent:` refs have
  corresponding `.md` files (or returns a specific error listing which are missing
  so Claude can create them first)
- For `kind: chain`: all `agent:` step refs have corresponding `.md` files
- `guardrail` field is valid
- No duplicate block name (unless `overwrite: true`)

Returns: `{ path, warnings[], missing_agents[] }` — if `missing_agents` is
non-empty, the tool succeeds but Claude should create those defs before the
charter is runnable.

#### `charter_validate(name_or_yaml)`
Pure validation — no writes. Used by Claude to check a draft before committing.
Takes either a charter name (validates the live file) or a raw YAML string.
Returns a structured validation report. The only tool the user can safely invoke
without side effects.

#### `charter_delete(name)`
Removes a named block from `agent-chain.yaml`. Does NOT delete referenced agent
`.md` files (agents are independent). Requires explicit confirmation flag.

**Why not a `team_create` wizard that asks questions interactively?** Because
the conversation IS the wizard. Claude should reason about the task, propose a
structure in prose, write the YAML mentally, then call `charter_validate` to check
it before calling `charter_author` to commit. The tools are the guardrails on
the output, not the input. Keeping the tools simple means Claude's intelligence
is doing the work, not a brittle decision tree.

### 2.4 The Authoring Conversation Flow

When a user says "Form a team to do X", Claude's intended behavior:

```
1. UNDERSTAND — Ask clarifying questions if needed about problem type, 
   expected outputs, any constraints on agent count or topology.

2. AGENT-FIRST — Propose the roster before the topology. Name each agent,
   describe its role, list what skills/tools it needs. Ask user if they
   want to reuse existing agents (check catalog) or create new ones.

3. TOPOLOGY — Given the agents, propose the topology. For most tasks:
   hub-spoke with one coordinator. Explain the communication pattern.

4. DRAFT — Write the YAML block + any new agent .md files. Call
   charter_validate() to check. Fix any errors.

5. CREATE AGENTS — For each new agent def needed, call agent_author().
   Show the system prompt to the user for approval or edits.

6. COMMIT CHARTER — Call charter_author() with the validated YAML.

7. CONFIRM GUARDRAIL — Tell the user the guardrail setting and how to
   override it. Remind them of the agent count before they launch.
```

The key design principle: **agents are first-class, topology is second.** A
badly composed team of great agents is recoverable. A great topology built on
vague agent defs is not. Claude should spend more tokens on agent role clarity
than on connection graph design.

### 2.5 Unified Catalog Commands

**Decision: add `/catalog` as the unified entry point; keep `/chain-list` as a
backward-compatible alias that filters to `kind: chain` only.**

#### `/catalog [filter]`

Shows a formatted list of all catalog entries, grouped by kind:

```
AGENTS (3)
  dp-researcher   Researches Netflix data platform services  [skills: og,cy,ta,wp]
  dp-synthesizer  Structures research findings into KB entries
  dp-lead         Coordinates research tasks and delegates to specialists

CHAINS (2)
  pitch-lab       Turn a one-line idea into a tagline, then critique it  [2 steps]
  dp-research     Research a data platform topic end-to-end  [2 steps]

TEAMS (1)
  dp-research-team  Parallel specialists under a research lead  [3 members] [last run: 2d ago]
```

Optional filter: `/catalog agents`, `/catalog chains`, `/catalog teams`,
`/catalog --skill og`.

#### `/catalog <name>`

Shows full detail for one entry: the YAML block (for chains/teams), the system
prompt preview (for agents), last-run date + outcome (if run artifacts exist).

#### `/catalog new`

Shortcut that primes Claude to start the authoring conversation flow (Section 2.4).
Equivalent to typing "Help me create a new team or chain."

**What about the existing `/chain-list`?** Keep it. It's a fast alias. Its output
just changes to source from the same catalog reader instead of a separate load.
Eventually deprecate in favor of `/catalog chains`.

### 2.6 Session Awareness — "Should I Use a Team for This?"

**Decision: brief catalog digest injected into every default session prompt; 
detail-on-demand via `catalog_read` tool.**

Loading the full `agent-chain.yaml` into every session's context is wasteful —
especially as the catalog grows. But Claude should know what's available without
needing to ask. The solution is a two-tier approach:

**Tier 1 — Catalog digest at session start** (always present, low token cost):
A brief `catalog_summary()` function in `catalog.ts` generates a compact block:

```
Available multi-agent resources (use `catalog_read(name)` for details):
  CHAIN pitch-lab — idea → tagline → critique
  CHAIN dp-research — research a data platform topic end-to-end
  TEAM  dp-research-team — parallel research specialists [guardrail: confirm]
  (3 agents available — use `catalog_read` to inspect)
```

This is appended to the system prompt as a `<!-- catalog-digest -->` section,
updated on every `/reload`. It's intentionally terse — one line per entry.

**Tier 2 — `catalog_read(name)` tool** (on-demand):
Returns the full charter YAML or agent def when Claude decides to inspect before
using. Claude should call this before recommending a team to a user, to verify
the team is appropriate for the current task.

**Where should the guardrail awareness live?** The digest should always include
the guardrail setting for teams (`[guardrail: confirm]`). This lets Claude surface
to the user "FYI, launching this team will ask for your confirmation first" before
the user even types yes — managing expectations.

### 2.7 Guardrails Design

**Decision: per-charter `guardrail:` field with three values, plus a global
session-level override. Explicit confirmation is the safe default.**

The user's explicit concern: "some guardrails so we don't spin up many agents
unexpectedly." Here is the three-tier model:

#### Guardrail field values

| Value | Behavior | When to use |
|-------|----------|-------------|
| `confirm` | **(default)** Before any spawn, Claude presents a confirmation prompt listing all agents to be spawned and asks the user to approve. | Everything new or untested. |
| `auto` | Spawn without confirmation. No prompt. | Stable, frequently-used teams where the user is tired of confirming. Explicitly opt-in by the user. |
| `never` | Team cannot be launched via `run_team`. Can only be used manually via `launch_agent`. | Experimental or dangerous compositions the user wants to audit before running. |

#### Confirmation prompt format

When `guardrail: confirm`, the system presents (as a pi system message, not from
Claude):

```
┌─ Team Confirmation ───────────────────────────────────────────┐
│ Charter: dp-research-team                                      │
│ Task:    Research the Polaris catalog service                  │
│ Agents:  dp-lead, dp-researcher, dp-synthesizer (3 windows)   │
│ Persist: yes (agents stay alive after this run)               │
│                                                                │
│  Proceed? [Y/n]                                                │
└────────────────────────────────────────────────────────────────┘
```

This is a blocking read from stdin — same pattern as the existing guardrail in
`tmux-subagent.ts`. It lives in the `run_team` function (to be built), not in
`launch_agent`, so it wraps the whole team launch as one confirmation, not one
confirmation per member.

#### Soft size-check warning (additive, not a blocker)

Even for `guardrail: auto`, if the task input is short (< 100 tokens) and the
team has > 3 agents, prepend a soft warning to the output: "Note: this is a large
team for a short task — consider using a chain instead." Non-blocking. Advisory.
This catches the "I forgot I had auto on" case.

#### Global session override

A `/guardrail off` command disables all confirmations for the session (useful
when you're iterating quickly on a team). `/guardrail on` re-enables. The state
is session-local — it does NOT modify the charter YAML. It should print a
reminder when used: "Guardrails disabled for this session. Charter defaults
restored on next session start."

#### Where enforcement lives

- `run_team()` in `pi-chain.ts` (new): checks `guardrail` field before calling
  `spawnAgentWindow` for any member. This is the primary gate.
- `tmux-subagent.ts` `launch_agent()`: existing guardrail logic stays, handles
  imperative spawns. No change needed here.
- The two paths are independent. If a user calls `launch_agent(team: "...")` 
  directly (bypassing `run_team`), they bypass the new per-charter guardrail.
  This is acceptable — direct `launch_agent` use is already considered a power-
  user path.

---

## 3. Feature 2: Retrospective + Charter Improvement

### 3.1 Run Artifact Capture

**What exists today:**
- Session `.jsonl` logs at `~/.config/pi/sessions/<dir-slug>/<ts>_<id>.jsonl` —
  rich per-turn event data including tool calls, timing, token usage
- Coms-bus message files at `~/.pi/coms-bus/` — but these are typically cleaned
  up on `coms_shutdown` or session end

**What needs to be added:**

#### Run Manifest

A new `~/.config/pi/runs/<charter-name>/<timestamp>_<run-id>_manifest.json`
written by `spawnAgentWindow()` (in `agent-spawn.ts`) when a team or chain run
starts, and updated when it ends.

See Section 5.2 for the full schema. Key fields:
- `run_id` — UUID, primary key for all artifacts
- `charter` — name of the chain or team block in `agent-chain.yaml`
- `kind` — `chain` | `team`
- `task` — the input text (truncated to 500 chars for the manifest)
- `guardrail_confirmed` — boolean, was confirmation given?
- `started_at` / `ended_at` — ISO timestamps
- `outcome` — `success` | `error` | `user-cancelled` | `agent-died`
- `agents` — map of agent name → per-agent timing, session file path, message counts
- `coms_namespace` — the `--project` flag used for this run (for coms-bus log lookup)
- `coms_preserved` — whether coms-bus files were kept for retro

**Where the manifest is written:**
- `spawnAgentWindow()` in `agent-spawn.ts` currently has no concept of run-level
  grouping. We need to add a `runId` parameter to `SpawnHandle` options, and a
  `writeRunManifest()` / `updateRunManifest()` helper that `pi-chain.ts` calls
  for chain runs and that the future `run_team()` calls for team runs.
- The chain orchestrator (`pi-chain.ts`) already has the run scope — it calls
  `spawnAgentWindow` in a loop. The manifest open/close naturally lives there.

#### Coms-Bus Message Preservation

Currently `coms_shutdown` cleans up the inbox files under `~/.pi/coms-bus/`.
For retro purposes, we need an option to keep them. The proposed change:

In `coms-bus.ts`, add a `preserve_run(run_id)` call that copies all current
inbox files to `~/.config/pi/runs/<charter-name>/<run-id>_coms/` before cleanup.
This is opt-in: only called when a charter has a run manifest (i.e. was launched
via `run_team` or `run_chain`, not bare `launch_agent`).

#### Performance Log

A `~/.config/pi/runs/<charter-name>/performance.jsonl` file (one line per run,
append-only). Written at run end, after the manifest is closed. Schema in
Section 5.3. This is the cross-run learning input for the retro agent.

### 3.2 Retrospective Trigger UX

**Decision: always opt-in, never automatic. Two surfaces: post-run offer and
explicit `/retro` command.**

Automatic retros after every run would be noise. The right triggers:

#### After `/team-down`
When the user explicitly tears down a team, the system prints:

```
Team dp-research-team shut down. Run time: 4m 32s · 3 agents · 24 messages.
Run a retrospective? /retro dp-research-team  (or just /retro to pick a run)
```

Non-blocking — this is just a hint in stdout, no spinner, no confirmation needed.

#### After chain completion
The existing flow widget auto-dismisses after 10s. Add a footer line during the
`done` state:

```
✓ dp-research  done in 2m 18s
  /retro dp-research to analyze this run
```

This disappears with the widget. If the user wants to retro, they type `/retro`.

#### `/retro [charter-name] [run-id]`
The explicit command. With no args: shows a picker of recent runs (last 10 across
all charters, sorted by recency). With `charter-name`: shows runs for that charter.
With both: goes directly to the retro for that specific run.

**Why not trigger automatically after every run?**
Because most runs will be clean and the user knows it. Mandatory retros become
ignored retros. Reserve the retro for: runs that felt slow, runs that produced
unexpected output, or runs where the user wants to improve the charter. Let the
user decide. The offer is cheap; the retro itself is a full agent run.

### 3.3 Retrospective Analysis

**Decision: a dedicated `retro-agent.md` persona, not an inline tool. The retro
is an agent run, not a function call.**

The retro analysis is complex enough that it should be done by a full Claude
invocation with the run artifacts loaded into context — not by a deterministic
function. A retro agent can reason about tradeoffs, notice things we didn't
parameterize, and produce natural-language suggestions rather than rigid diffs.

#### What the retro agent reads

1. **Run manifest** — the structured summary (timing, outcome, agent list, coms
   namespace). The primary structured input.
2. **Session `.jsonl` logs** for each agent — tool calls, messages, timing events.
   The retro agent reads these to understand what each agent actually did (not just
   what it was supposed to do).
3. **Preserved coms-bus messages** (if available) — the actual inter-agent messages.
   Reveals: who sent too many messages, who didn't respond, unexpected message
   patterns.
4. **Performance log** (`performance.jsonl`) — the history of prior runs of this
   same charter. The retro agent MUST read this before making suggestions, so it
   can identify trends ("this is the third run where the synthesizer was slow").
5. **The charter YAML itself** — the current definition, to diff against observed
   behavior.
6. **The agent `.md` files** for all members — the system prompts, to identify
   misalignment between what agents were told to do and what they did.

#### Analysis sections

The retro agent produces a structured markdown report with these sections:

**Communication Graph** — who sent to whom, how many messages, any anomalies
(agent that never received a reply, excessive back-and-forth on one topic).

**Timing Analysis** — wall time per agent (from manifest), cumulative chain time,
which agent was the bottleneck. If one agent consumed > 60% of total time, flag it.

**Output Quality** — did each agent's output match what the next step expected?
For chains: did `$INPUT` to step N+1 seem coherent with step N's output? For
teams: did the coordinator's final synthesis use contributions from all specialists?

**Gap Analysis** — things that were asked for in the original task that no agent
addressed well. This requires the retro agent to re-read the original task and
check each major requirement against the outputs.

**Charter Alignment** — did agents behave as described in their `.md` system
prompts? Common drift: an agent that was told "delegate, don't do the work yourself"
but ended up doing deep work directly instead of routing to specialists.

**Trend Analysis** (if performance log has > 1 entry) — are things getting better
or worse across runs? Is a particular agent consistently slow or consistently
under-used?

#### Retro agent invocation

The retro agent is spawned via `launch_agent` (not `run_team` — it's a single
agent, not a team). It receives a task prompt containing:
- The run manifest (formatted as context)
- Paths to session logs
- Path to performance.jsonl
- Instructions to produce the structured report format
- Path to write its output: `~/.config/pi/runs/<charter>/<run-id>_retro.md`

The retro is a **fire-and-watch** subagent run, same as `dp-researcher`. The user
sees the retro agent's window. When done, the report is at the known path and the
retro tool surfaces it.

### 3.4 Charter Improvement Output Format

**Decision: suggestions as structured diffs in the retro report, accepted via
`charter_apply(run_id, suggestion_ids)`.**

The retro report (`<run-id>_retro.md`) has a structured suggestions section at
the end. Each suggestion has a machine-readable header so `charter_apply` can
parse and apply them without the user needing to manually edit files:

```markdown
## Suggestions

<!-- suggestion: S1 -->
### S1 — System prompt update: dp-researcher

**Type:** agent-patch
**File:** ~/.config/pi/agents/dp-researcher.md
**Rationale:** Agent took 3x longer than expected because it re-read orientation
files on every invocation. A persistent team could benefit from a note in the
system prompt to skip orientation on subsequent topics.

**Change:**

\`\`\`diff
-Always read the four orientation files above before starting
+On first invocation: read the four orientation files above before starting.
+On subsequent topics in the same session: skip orientation — context is warm.
\`\`\`

<!-- /suggestion -->

<!-- suggestion: S2 -->
### S2 — Charter update: dp-research-team

**Type:** yaml-patch
**Charter:** dp-research-team
**Rationale:** The synthesizer never received a direct message from the researcher
in 3 of 4 runs — all synthesis was done by the lead. Consider removing the
synthesizer or merging its role into the lead.

**Change:**

\`\`\`diff
   members:
     - agent: dp-lead
       role: coordinator
-    - agent: dp-researcher
+    - agent: dp-researcher    # Note: synthesizer removed — lead handles synthesis
       role: specialist
-    - agent: dp-synthesizer
-      role: specialist
\`\`\`
<!-- /suggestion -->
```

#### Reviewing and applying suggestions

`charter_review(run_id)` — displays the retro report in a pager. Shows each
suggestion with its rationale. Claude can also summarize the suggestions verbally
when asked.

`charter_apply(run_id, suggestion_ids)` — applies one or more suggestions by
their IDs (e.g. `charter_apply("abc123", ["S1", "S2"])`). Before any write:
  - Backs up affected files to `<name>.md.bak.<timestamp>` or
    `agent-chain.yaml.bak.<timestamp>`
  - Applies the diff using line-by-line string matching (same approach as
    `agent_update` — no `patch` binary dependency)
  - Validates the result with `charter_validate` before writing
  - Records the applied suggestions in the performance log (`retro_applied: ["S1"]`)

`charter_fork(run_id, new_name, suggestion_ids)` — variant that creates a new
charter under `new_name` instead of modifying the existing one. Useful when the
user wants to test a variation without destroying the known-good charter.

**Format stability concern:** The suggestion blocks use HTML comments as machine-
readable delimiters (`<!-- suggestion: S1 -->`). This is robust enough for simple
parsing without requiring a new file format. The retro agent is instructed to
always produce suggestions in exactly this format.

### 3.5 Cross-Run Learning

**Decision: performance.jsonl as the cross-run memory. Retro agent reads it as
a required step, not optional.**

The `performance.jsonl` format (Section 5.3) accumulates one entry per run. The
retro agent is instructed to read this file and look for:

- **Recurrence** — same bottleneck across 3+ runs → strong signal, not noise
- **Regression** — a metric was improving, then got worse after a charter patch
- **Unused agents** — an agent that appears in the manifest but has a
  `message_count_received: 0` across multiple runs → the agent is vestigial
- **Context drift** — `clearContext: false` agents in persistent chains tend to
  accumulate context that makes later topics slower; detectable via timing trend

The performance log is small (< 1KB per run entry) and grows slowly. Loading the
last 20 entries into a retro agent's context is cheap. No summarization needed
until a charter has > 50 runs (unlikely in the near term).

### 3.6 Agent Improvement Loop

**Decision: retro surfaces agent-level suggestions alongside charter-level ones,
using the same suggestion format. `charter_apply` handles both.**

The retro agent should inspect each agent's `.md` system prompt and compare it
against the observed behavior in the session logs. Common improvement patterns:

- **System prompt too long / too many rules** — agent spent many turns and the
  output was scattered; suggestion: tighten the system prompt
- **Missing output format instruction** — agent output didn't cleanly feed the
  next stage; suggestion: add explicit output format rules
- **Role confusion** — agent doing work outside its stated role; suggestion:
  add explicit "you are NOT responsible for X" lines
- **Orientation cost** — agent re-reads orientation files every invocation in a
  persistent team; suggestion: add persistent-session fast path

The agent patch suggestion format (same as Section 3.4) uses `type: agent-patch`
with a diff block. `charter_apply` uses `agent_update()` under the hood to apply
it, which automatically creates a backup.

**Tweak-as-you-go philosophy:** the retro is the formal improvement loop, but the
user can also use `agent_update()` ad-hoc at any time to tweak an agent mid-project.
The two mechanisms are complementary. The retro system doesn't need to know about
informal tweaks — it will observe their effect in the next run's artifacts.

---

## 4. Implementation Roadmap

Ordered steps. Each step has a reference to what code it touches and what's new
vs. reuse. Steps within a phase can generally be done in parallel; phases must be
sequential.

---

### Phase A — Foundation: Catalog + Schema *(prerequisite for everything)*

#### A1. Parse `kind: team` in `loadChains()` — `pi-chain.ts`
**What:** Remove the `kind !== 'chain'` skip in `loadChains`. Add a `TeamDef` type
(parallel to `ChainDef`). Parse `members`, `topology`, `guardrail`, `entry_point`,
`persist`, `comms`. Return a `Catalog` type: `{ chains: Map<string,ChainDef>,
teams: Map<string,TeamDef> }`.

**Reuse:** `mini-yaml.ts` (unchanged), existing chain parsing logic as template.

**New:** `TeamDef` and `TeamMember` types; `comms` parsing; `guardrail` enum.

**Test:** Add a `kind: team` block to `agent-chain.yaml`, verify it parses without
errors and appears in the returned catalog.

---

#### A2. Create `catalog.ts` extension
**What:** New extension file. Registers three tools:
- `catalog_list(kind?: "agent"|"chain"|"team")` — reads agent defs + YAML, returns
  formatted summary string
- `catalog_read(name)` — returns full content (YAML block or .md content) for one
  entry
- `catalog_validate(name_or_yaml)` — validates a charter name or raw YAML string;
  returns structured errors

Also exposes an internal `catalogDigest(): string` function used by the session
startup hook.

**Reuse:** `loadChains()` (updated in A1), `loadAgentDef()` from `agent-spawn.ts`,
`mini-yaml.ts`.

**New:** Agent def directory scan, digest formatter, catalog display formatter.

**Also adds:** `/catalog` and `/catalog <name>` command handlers (these live in
the extension's command handler, same pattern as `/chain-list` in `pi-chain.ts`).

---

#### A3. Inject catalog digest into default session prompt
**What:** In the session startup path (wherever the system prompt is assembled),
call `catalogDigest()` from `catalog.ts` and append it as a `<!-- catalog-digest
-->` block. Regenerate on `/reload`.

**Reuse:** Existing session startup/reload hooks.

**Tricky part:** The session startup path may be in pi core (not an extension). If
so, the digest must be exposed via a different mechanism — e.g. a `catalog.ts` hook
that writes the digest to a well-known tmpfile at startup, and pi core reads it.
Investigate the actual session startup hook mechanism first.

---

### Phase B — Authoring Tools

#### B1. Authoring tools in `catalog.ts`
**What:** Add to the existing `catalog.ts` extension:
- `agent_author(name, content)` — validate + write agent `.md`
- `agent_update(name, field, value)` — targeted patch with backup
- `charter_author(name, yaml_block, overwrite?)` — validate + write to `agent-chain.yaml`
- `charter_delete(name, confirm)` — remove a named block

**Reuse:** `mini-yaml.ts` (validation), `catalog_validate()` from A2, `loadChains()`.

**New:** YAML block append/replace logic (careful with the file-level
append-vs-update distinction — need to scan for an existing block by name, replace
in-place if found, append if not).

---

#### B2. Add `guardrail` enforcement to `run_team()` in `pi-chain.ts`
**What:** When `run_team` is implemented (Phase E), it reads the `guardrail`
field. If `confirm`: present the confirmation prompt and block. If `never`: return
error immediately. Session-level override: check `sessionGuardrailOverride` state.

**Reuse:** Existing guardrail prompt pattern in `tmux-subagent.ts`.

**Note:** Don't implement `run_team` in this phase — just design the guardrail
interface so it's ready when E1 lands.

---

#### B3. Charter fork tool
**What:** `charter_fork(source_name, new_name)` — copies a YAML block under a new
name. Mostly a convenience wrapper on `charter_author`. Useful for testing charter
variants and for the retro `charter_apply` fork path.

**Reuse:** `charter_author()` from B1.

---

### Phase C — Run Artifact Capture

#### C1. Run manifest writer in `pi-chain.ts`
**What:** At the start of `run_chain()` / `run_team()` (once implemented): open a
run manifest JSON at `~/.config/pi/runs/<charter>/<timestamp>_<run-id>_manifest.json`.
Record: run_id (UUID), charter name, kind, task (truncated), started_at.
At the end: update with ended_at, outcome, per-agent timing gathered from
`AgentState` snapshots.

**Reuse:** `agent-spawn.ts` `SpawnHandle` (read `stateFile` path from it to locate
the session log), UUID generation (Node's `crypto.randomUUID()`).

**New:** `openRunManifest()`, `closeRunManifest()` helpers. `~/.config/pi/runs/`
directory creation (one-time mkdir).

---

#### C2. Per-agent timing in run manifest
**What:** The chain loop already records `startedAt` and reads the final
`AgentState`. Extend to record per-agent: `started_at`, `ended_at`, `input_tokens`,
`output_tokens` (from `AgentUsage` in state), `session_file` path (from the
`stateFile` prefix), `message_count_sent`, `message_count_received` (from
coms-bus — only meaningful for teams, but log 0 for chains).

**Reuse:** `AgentUsage`, `AgentState`, `AgentStatus` types from `agent-spawn.ts`.

---

#### C3. Performance log accumulation
**What:** After `closeRunManifest()`, append one line to
`~/.config/pi/runs/<charter>/performance.jsonl`. See schema in Section 5.3.

**Reuse:** Run manifest data from C1/C2. Simple `fs.appendFileSync` + JSON.stringify.

---

#### C4. Coms-bus message preservation
**What:** In `coms-bus.ts`, add a `preserve_run(run_id, charter)` export that
copies current inbox files to `~/.config/pi/runs/<charter>/<run-id>_coms/` before
the normal cleanup. Called from `run_team()` before `coms_shutdown` (if the
charter has a run manifest open).

**Reuse:** Existing coms-bus file paths. `fs.cpSync` or loop over `readdirSync`.

---

### Phase D — Retrospective

#### D1. Create `retro-agent.md`
**What:** New agent def at `~/.config/pi/agents/retro-agent.md`. System prompt
instructs it to:
- Read the run manifest at the path given in its task
- Read each session log path listed in the manifest
- Read `performance.jsonl` for the charter
- Read the charter YAML and each referenced agent's `.md`
- Produce a retro report at `~/.config/pi/runs/<charter>/<run-id>_retro.md`
  following the structured suggestion format from Section 3.4
- Be opinionated: every retro must include at least one actionable suggestion
  (even if it's "no changes needed — note why")

**Reuse:** Same file format as `dp-researcher.md`. Skills: probably `og` (file
read/write) only — retro agent doesn't need web access.

---

#### D2. Create `retro.ts` extension
**What:** New extension. Registers:
- `retro_list(charter?)` — lists available run manifests. Shows: run_id, charter,
  date, outcome, retro status (pending/done)
- `retro_run(run_id)` — launches `retro-agent` as a subagent with the run manifest
  path as task. Waits for completion. Returns path to the retro report.
- `retro_show(run_id)` — reads and displays the retro report for a run
- `charter_review(run_id)` — displays suggestions section only (parsed from
  retro report)
- `charter_apply(run_id, suggestion_ids)` — applies specific suggestions using
  `agent_update()` / `charter_author()` from B1. Records applied IDs in manifest.
- `charter_fork(source_name, new_name, run_id?, suggestion_ids?)` — creates a
  fork with suggestions pre-applied

Also handles the `/retro [charter] [run-id]` command: shows picker if needed,
launches `retro_run`, then `charter_review`.

**Reuse:** `catalog.ts` tools (B1) for applying patches, `launch_agent` primitive,
`agent-spawn.ts`.

---

#### D3. Post-run retro offer hooks
**What:** In `pi-chain.ts`, after `runChain()` completes (both chain and team),
print the retro hint line (Section 3.2). For `/team-down`, add the retro hint to
the teardown output message.

**Reuse:** `pi-chain.ts` completion handlers.

---

### Phase E — `run_team()` (the actual team executor)

This is the "Step 7" from CHAIN_BUILD_PLAN.md, now with a full design.

#### E1. Implement `hub-spoke` topology in `run_team()` — `pi-chain.ts`
**What:** The team executor for `topology: hub-spoke`.

Flow:
1. Open run manifest (C1)
2. Check guardrail (B2) — block/confirm if needed
3. Spawn `entry_point` agent (the coordinator/hub) via `spawnAgentWindow`. Initial
   task is the `run_team` input, substituted via `fillTemplate`.
4. Spawn all other members in parallel (non-blocking spawn; don't await completion).
   These agents are told to listen on the coms-bus and await delegation from the hub.
5. Watch the hub's `stateFile`. When hub reaches `done` state: tear down all members,
   close run manifest, offer retro hint.
6. If any member dies unexpectedly: log to manifest, continue (the hub may or may
   not recover; that's the hub's problem).

**Reuse:** `spawnAgentWindow()`, `fillTemplate()`, existing state polling loop from
`pi-chain.ts` (the `runStep` wait loop), `coms-bus.ts` (members communicate via
existing coms-bus primitives — no new IPC).

**New:** Parallel spawn (Promise.all over member spawns), hub-watches-members-die
loop, team teardown (`teardownTeam()` analog of `teardownLiveTeam()`).

---

#### E2. Wire `run_chain()` dispatch to `run_team()`
**What:** In `run_chain()`, when the loaded charter is a `TeamDef` instead of a
`ChainDef`, dispatch to `run_team()`. This is the payoff of the `kind:` discriminator.

**Reuse:** `loadChains()` (A1 returns both chains and teams in one catalog).

---

#### E3. Flow widget update for teams
**What:** The existing flow widget shows a linear pipeline. For teams: show a
roster view instead (one row per member, status glyph, elapsed time). Reuse
the same widget lifecycle (auto-dismiss 10s after done, `/chain-show` to redisplay
— or rename to `/charter-show`).

**Reuse:** `pi-chain.ts` flow widget code. Widget update logic is already
abstracted enough to swap rendering.

---

### Phase F — Polish (post-validation)

- `F1` — `/catalog new` conversational authoring shortcut
- `F2` — Cross-run trend reporting in retro (requires 3+ runs of same charter;
  wait until data exists before building)
- `F3` — `mesh` topology in `run_team()` (after hub-spoke is battle-tested)
- `F4` — Nesting: a chain `step` that references a `team` charter by name (the
  "end goal" from CHAIN_BUILD_PLAN.md). At this point `run_chain` and `run_team`
  are fully composable.
- `F5` — `/charter-show` rename (unify `/chain-show` and the new team show)

---

## 5. Schema Proposals

### 5.1 Full `kind: team` YAML Block

```yaml
# In ~/.config/pi/agents/agent-chain.yaml

dp-research-team:
  kind: team
  description: "Parallel specialists researching a data platform topic under a lead coordinator"
  guardrail: confirm           # confirm | auto | never  (default: confirm)
  persist: true                # keep agents alive between run_team calls
  topology: hub-spoke          # hub-spoke | mesh | chain | custom
  entry_point: dp-lead         # agent that receives the initial task

  members:
    - agent: dp-lead
      role: coordinator
      description: "Receives the task, delegates subtasks, synthesizes final answer"

    - agent: dp-researcher
      role: specialist
      description: "Deep-dives on assigned service, writes raw findings"
      reports_to: dp-lead

    - agent: dp-synthesizer
      role: specialist
      description: "Structures raw findings into a KB entry"
      reports_to: dp-lead

  # Optional: communication pattern labels (used by retro for graph analysis)
  comms:
    - label: delegation
      from: dp-lead
      to: "*"
    - label: findings
      from: dp-researcher
      to: dp-lead
    - label: kb-entry
      from: dp-synthesizer
      to: dp-lead
```

### 5.2 Run Manifest Schema

File: `~/.config/pi/runs/<charter-name>/<timestamp>_<run-id>_manifest.json`

```json
{
  "run_id": "7f3a1b2c-...",
  "charter": "dp-research-team",
  "kind": "team",
  "task": "Research the Polaris catalog service and its dependency graph",
  "task_truncated": true,
  "guardrail": "confirm",
  "guardrail_confirmed": true,
  "guardrail_session_override": false,
  "started_at": "2025-01-15T10:00:00.000Z",
  "ended_at": "2025-01-15T10:04:32.000Z",
  "outcome": "success",
  "coms_namespace": "--Users-charsmith-code-hacking-clarity-cli",
  "coms_preserved": true,
  "coms_archive_path": "~/.config/pi/runs/dp-research-team/7f3a1b2c_coms/",
  "retro_status": "pending",
  "retro_path": null,
  "retro_suggestions_applied": [],
  "agents": {
    "dp-lead": {
      "session_id": "ses_abc123",
      "session_file": "~/.config/pi/sessions/--Users-charsmith.../20250115_ses_abc123.jsonl",
      "started_at": "2025-01-15T10:00:01.000Z",
      "ended_at": "2025-01-15T10:04:30.000Z",
      "duration_ms": 269000,
      "input_tokens": 3200,
      "output_tokens": 1100,
      "message_count_sent": 4,
      "message_count_received": 6,
      "exit_status": "done"
    },
    "dp-researcher": {
      "session_id": "ses_def456",
      "session_file": "~/.config/pi/sessions/--Users-charsmith.../20250115_ses_def456.jsonl",
      "started_at": "2025-01-15T10:00:05.000Z",
      "ended_at": "2025-01-15T10:03:50.000Z",
      "duration_ms": 225000,
      "input_tokens": 8400,
      "output_tokens": 4200,
      "message_count_sent": 3,
      "message_count_received": 2,
      "exit_status": "done"
    }
  }
}
```

### 5.3 Performance Log Schema

File: `~/.config/pi/runs/<charter-name>/performance.jsonl`

One JSON line per run, appended at run close:

```jsonl
{"run_id":"7f3a1b2c","charter":"dp-research-team","kind":"team","task_summary":"Research Polaris catalog service","started_at":"2025-01-15T10:00:00Z","duration_ms":272000,"outcome":"success","agent_count":3,"bottleneck_agent":"dp-researcher","bottleneck_pct":83,"total_input_tokens":11600,"total_output_tokens":5300,"message_count":13,"retro_applied":[],"notes":""}
{"run_id":"9a2c4e5f","charter":"dp-research-team","kind":"team","task_summary":"Research Maestro orchestration service","started_at":"2025-01-16T14:30:00Z","duration_ms":310000,"outcome":"success","agent_count":3,"bottleneck_agent":"dp-researcher","bottleneck_pct":79,"total_input_tokens":14200,"total_output_tokens":6100,"message_count":17,"retro_applied":["S1"],"notes":"Applied S1 from prior retro — no measurable effect yet"}
```

### 5.4 Retro Report Structure

File: `~/.config/pi/runs/<charter-name>/<run-id>_retro.md`

```markdown
# Retrospective: dp-research-team / run 7f3a1b2c
Generated: 2025-01-15T10:15:00Z
Charter: dp-research-team (hub-spoke, 3 members)
Task: Research the Polaris catalog service

---

## Summary
The run completed successfully in 4m 32s. The researcher was the bottleneck (83%
of wall time), consistent with the prior run on this charter. The synthesizer was
underused — it received one delegation and produced output that the coordinator
had already partially drafted. Two actionable suggestions follow.

## Communication Graph
dp-lead → dp-researcher: 2 messages (delegation, follow-up clarification)
dp-lead → dp-synthesizer: 1 message (delegation)
dp-researcher → dp-lead: 3 messages (partial findings × 2, final summary)
dp-synthesizer → dp-lead: 1 message (KB entry draft)

**Anomaly:** dp-synthesizer was only active for 38s of a 272s run. The lead's
final synthesis incorporated the researcher's output directly rather than routing
through the synthesizer.

## Timing Analysis
dp-lead:        4m 29s  (wall, includes wait time)
dp-researcher:  3m 45s  ← bottleneck (83% of total active time)
dp-synthesizer: 0m 38s  (underused)

## Output Quality
dp-researcher → dp-lead: output was well-formed; lead used it directly.
dp-synthesizer → dp-lead: output was a valid KB entry but duplicated work the
lead had already done. The coordinator did not wait for the synthesizer before
drafting the synthesis.

## Gap Analysis
The original task asked for "dependency graph" in addition to a service overview.
The final output describes Polaris's dependencies in prose but does not include a
structured list or diagram. No agent was explicitly responsible for dependency
extraction.

## Trend Analysis (2 runs)
- dp-researcher has been the bottleneck in both runs (83% / 79% of active time).
- Total run time increased 14% between runs despite applying S1 from the prior retro.
- Synthesizer underuse is consistent across both runs.

---

## Suggestions

<!-- suggestion: S2 -->
### S2 — Remove dp-synthesizer or merge its role into dp-lead

**Type:** yaml-patch
**Charter:** dp-research-team
**Rationale:** The synthesizer has been underused in both runs. The coordinator
is performing the synthesis directly. Either remove the synthesizer and add
explicit synthesis instructions to dp-lead's system prompt, or give the
synthesizer a more specific role (e.g. dependency extraction only) so it does
non-overlapping work.

**Change (option A — remove):**

\`\`\`diff
   members:
     - agent: dp-lead
       role: coordinator
     - agent: dp-researcher
       role: specialist
-    - agent: dp-synthesizer
-      role: specialist
-      reports_to: dp-lead
\`\`\`

<!-- /suggestion -->

<!-- suggestion: S3 -->
### S3 — Add dependency extraction responsibility to dp-researcher

**Type:** agent-patch
**File:** ~/.config/pi/agents/dp-researcher.md
**Rationale:** Two runs have missed the dependency graph requirement. Adding an
explicit step to the researcher's workflow would close this gap.

**Change:**

\`\`\`diff
 ## Rules
 - Always read the four orientation files above before starting
+- For any service, always extract: (1) direct dependencies (services it calls),
+  (2) direct dependents (services that call it). Include as a structured list.
 - Always check `cloned-repos.md` before cloning
\`\`\`

<!-- /suggestion -->
```

### 5.5 Agent Def Frontmatter — No Breaking Changes

The existing frontmatter schema is unchanged. No new required fields. The `retro`
system treats agent `.md` files as read/write artifacts but does not require
agents to declare anything about retro compatibility. The only convention is that
backup files use the pattern `<name>.md.bak.<unix-timestamp>`.

---

## 6. Open Questions

These need user input before the relevant phase can be built.

### OQ-1: Session startup hook for catalog digest (Phase A3)
**Question:** Is there a supported hook in pi core for injecting content into the
system prompt at session start/reload? Or does this have to be done via a skill
file that Claude reads on demand?

**Why it matters:** If there's no hook, the "catalog awareness" feature degrades
to a skill file that Claude is told to read — workable but less automatic. Need
to investigate the pi extension API before designing this.

**Fallback:** Write `~/.config/pi/skills/catalog-digest.md` as a static (auto-
refreshed on `/reload`) skill. This is opt-in (the user enables the skill) rather
than always-on.

---

### OQ-2: Coms-bus cleanup timing (Phase C4)
**Question:** When exactly are coms-bus inbox files cleaned up? Is it on
`coms_shutdown` tool call, on session end, or on process exit? And is the cleanup
per-inbox or the whole namespace directory?

**Why it matters:** The `preserve_run()` call must happen *before* cleanup. If
cleanup is in a signal handler or session-end hook, timing gets tricky. Need to
audit `coms-bus.ts` cleanup code paths before implementing C4.

---

### OQ-3: `/team-down` — does it exist yet?
**Question:** Is `/team-down` an existing command (analogous to `/chain-down`), or
does it need to be added as part of Phase E?

**Why it matters:** The retro offer hook (Phase D3) attaches to `/team-down`. If
it doesn't exist yet, we build it in E1 alongside `run_team()`. If it does exist
in `tmux-subagent.ts`, we add the hook there instead.

---

### OQ-4: Session log format — do we know the `type` values?
**Question:** The session `.jsonl` files contain JSON events with a `type` field.
What are the actual type values for: turn start, turn end, tool call, tool result,
agent message? And is token usage recorded per-turn or per-session?

**Why it matters:** The retro agent needs to read these logs and extract timing +
token data. If we don't know the format, the retro agent's system prompt can't
accurately describe what to look for. A quick `cat` of any session log would
answer this.

---

### OQ-5: Guardrail UX — blocking stdin read vs. tool result?
**Question:** The existing guardrail in `tmux-subagent.ts` uses a blocking
`readline` prompt. Is that the right UX for team confirmation, or should it be
a pi-native confirmation dialog (if one exists)?

**Why it matters:** For large teams (5+ agents), the confirmation needs to show
the full agent list. A multi-line readline prompt works but is awkward. If pi has
a richer confirmation primitive, use it. If not, the readline approach is fine for
now.

---

### OQ-6: Charter authoring — should Claude write agent `.md` files directly, or go through `agent_author`?
**Question:** Claude already has `Write` file access. Should the authoring tools
be advisory (validate-only, Claude still writes files directly), or should they be
the only sanctioned path for writing agent defs?

**Recommendation:** Tools should be the sanctioned path. Even though Claude can
write files directly, using `agent_author` ensures: (a) validation runs, (b)
the backup-before-modify convention is enforced, (c) the catalog stays coherent.
Make this a convention enforced by system prompt instruction ("always use
`agent_author` and `charter_author` to write or modify agent/charter files"),
not a hard technical block.

**User call needed:** Confirm whether hard-blocking direct file writes to
`~/.config/pi/agents/` is desirable, or whether the convention + tools approach
is sufficient.

---

### OQ-7: Performance log retention policy
**Question:** How long should run manifests and performance logs be kept? They
accumulate indefinitely as written. Should `/retro clean` prune old runs? Should
there be a max run count per charter?

**Recommendation:** No auto-cleanup for now. These files are tiny (< 5KB/run
manifest, < 200 bytes/performance entry). Add `/retro clean <charter> --keep-last
N` as a future F-phase command. Revisit when storage becomes noticeable.

---

### OQ-8: Topology for the first real team
**Question:** What is the first real team to build and test against? The `dp-
research-team` in this doc is a placeholder based on the existing `dp-researcher`
agent. Should we build that, or is there a higher-priority composition?

**Why it matters:** The first real team drives all the implementation details —
how many members, what topology, what the coms patterns actually look like in
practice. Building `run_team` without a real test target leads to over-engineered
abstractions. Pick a concrete team early in Phase E and build to it.

---

## 7. File-Level Change Summary

For each implementation phase, the files touched:

| Phase | File(s) | Change Type |
|-------|---------|-------------|
| A1 | `extensions/pi-chain.ts` | Modify: parse `kind: team`, add `TeamDef` type |
| A2, B1 | `extensions/catalog.ts` | **New file** |
| A3 | session startup (TBD) | Modify: inject catalog digest |
| B2 | `extensions/pi-chain.ts` | Modify: guardrail check in `run_team()` |
| B3 | `extensions/catalog.ts` | Modify: add `charter_fork` |
| C1–C3 | `extensions/pi-chain.ts` | Modify: run manifest open/close |
| C4 | `extensions/coms-bus.ts` | Modify: add `preserve_run()` export |
| D1 | `agents/retro-agent.md` | **New file** |
| D2–D3 | `extensions/retro.ts` | **New file** |
| E1–E2 | `extensions/pi-chain.ts` | Modify: add `run_team()`, dispatch from `run_chain()` |
| E3 | `extensions/pi-chain.ts` | Modify: team flow widget renderer |

Net-new files: `catalog.ts`, `retro-agent.md`, `retro.ts`.
Most-modified file: `pi-chain.ts` (teams are a topology of the same executor).
Least-touched: `tmux-subagent.ts`, `coms-bus.ts`, `agent-spawn.ts` — changes
are additive and minimal by design. The primitive layer stays stable.

---

*End of TEAM_DESIGN_PLAN.md*

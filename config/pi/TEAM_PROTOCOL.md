# Team Protocol

Companion to `TEAM_DESIGN_PLAN.md`. Captures the concrete runtime protocol for
agent teams — state machines, coordinator contract, storage layout, config.
Design is settled; implementation is next.

---

## Agent State Machine

### Workers (all non-coordinator team members)

```
startup → idle
idle    → working   (message received from coordinator)
working → idle      (response sent)
                    (skip the idle write if another message is already queued —
                     just keep working; no one cares about a momentary idle flash)
```

Workers never signal "done". Completion is entirely the coordinator's concern.

### Coordinator (launched-by-something mode)

```
startup   → idle
idle      → working   (message received OR first task injected)
working   → idle      (turn done, more work remains)
working   → completed (all work done → write output.md → signal parent)
```

`completed` is distinct from `idle` — it means "unit of work finished, report
written, parent should be notified." The coordinator can then exit or wait; for
v1 it exits, tearing the team down with it.

### Status values (full set)

| Status      | Who uses it    | Meaning |
|-------------|----------------|---------|
| `running`   | any            | currently in a turn (LLM thinking / calling tools) |
| `idle`      | persistent only | between turns, alive, waiting for next message |
| `working`   | alias for running in team context — same wire value, different label in TUI |
| `stopped`   | any            | paused for guardrails input |
| `completed` | coordinator    | unit of work done, output.md written |
| `done`      | non-persistent | pane exited cleanly |
| `error`     | any            | pane exited with error |

Wire simplification: `working` = `running` on the wire (no schema change needed).
The TUI reads context (team member vs solo agent) to decide whether to label it
"running" or "working".

---

## Coordinator Contract

### How the launcher designates a coordinator

At spawn time, `spawnAgentWindow` receives a `coordinator` option. This causes
two things:

1. Extra env vars injected into the child:
   ```
   PI_COORDINATOR=1
   PI_WORK_DIR=~/code/agent-teams/<team-name>/<unit-of-work-id>
   ```

2. The child extension writes `input.md` to the work dir from the task text,
   then injects into the coordinator's system prompt (via `before_agent_start`):
   ```
   You are the coordinator for this team.
   Unit of work: <unit-of-work-id>
   Your task is in: <work-dir>/input.md
   When your work is complete:
     1. Write your report to <work-dir>/output.md
     2. Your session will signal completion automatically.
   Do not exit until you have written output.md.
   ```

### How the coordinator signals done

The coordinator writes `output.md`, then calls a pi tool (or the child extension
provides a helper) that writes `status: "completed"` to its state file.

In practice: the child extension polls for `output.md` to appear after each
`agent_end`. When it sees it, it writes `completed` to the state file. The
coordinator doesn't have to do anything special — just write the file.

Alternatively expose a tool `coordinator_done(summary)` that writes output.md
AND flips the status in one call. Cleaner UX for the coordinator agent.

### How the parent reacts

`pollAgentState` in `tmux-subagent.ts` already watches the state file on a 1s
tick + fs.watch. On seeing `completed`:

1. Read `output.md` from the work dir (path is in the state file or derivable
   from env)
2. Deliver a follow-up message to the main thread:
   ```
   Coordinator "<name>" finished unit of work "<id>".
   Report: ~/code/agent-teams/<team>/<id>/output.md

   <first ~500 chars of output.md>
   ```
3. Tear down the coordinator pane + all tracked team members (same project
   namespace) — unless `persist: true` was set at launch.

The main thread doesn't need to be on the coms bus for this. The state file
channel is the coordinator→parent signal; the coms bus is coordinator→workers.

---

## Storage Layout

```
~/code/agent-teams/              ← root, configurable in agent-teams.json
  <team-name>/
    <unit-of-work-id>/
      input.md                   ← task text, written by launcher at spawn
      output.md                  ← coordinator writes this when done
      debug.jsonl                ← optional: coms messages, timing, anything
```

### Unit-of-work ID format

`<YYYYMMDD-HHMMSS>-<task-slug>`

- Human-readable in directory listings
- Sortable by time
- Slug = first 40 chars of task text, lowercased, spaces→hyphens, non-alnum stripped

Example: `20260619-143022-research-the-polaris-catalog-service`

---

## Config File

`~/.config/pi/agent-teams.json`

```json
{
  "workdir": "~/code/agent-teams"
}
```

Starts minimal. Future fields: retention policy, default guardrail, default
topology, notification preferences. Same pattern as `guardrails.json`.

The config is read by `catalog.ts` (to be built) and by `spawnAgentWindow` when
a `coordinator` option is present.

---

## TUI Changes

### Widget card updates

| Status     | Icon | Color   | Label in card |
|------------|------|---------|---------------|
| `running`  | `●`  | accent  | `running` (solo) / `working` (team member) |
| `idle`     | `◦`  | dim     | `idle` |
| `completed`| `✓`  | success | `completed — report ready` |
| `stopped`  | `⚠`  | warning | `stopped` |
| `done`     | `✓`  | success | `done` |
| `error`    | `✗`  | error   | `error` |

### Coordinator badge

When a team member is the coordinator, its widget card gets a `[coordinator]`
tag on the name line so it's visually distinguishable in the TUI.

---

## Implementation Order

1. **`idle` status** — add to `AgentStatus`, write on `agent_end` for persistent
   agents, render in widget, deliver follow-up when transitioning `running→idle`
   (gives immediate visibility even before coordinator protocol is wired)

2. **`completed` status + `agent-teams.json` config** — new status value,
   parent reaction (follow-up + optional teardown), config reader

3. **Coordinator spawn option** — `coordinator: true` in `spawnAgentWindow` opts,
   work dir creation, `input.md` write, env var injection, system prompt injection

4. **`coordinator_done` tool** — available only inside coordinator sessions
   (`PI_COORDINATOR=1`), writes `output.md`, flips status

5. **Worker labeling in TUI** — detect team member context, show "working" vs
   "running", coordinator badge on name line

6. **Teardown on completed** — parent kills tracked team members in the same
   project namespace when coordinator reaches `completed`

# coms-bus — design & wiring

Peer-to-peer messaging bus between pi agents so an **orchestrator** can build a
*team* (e.g. one expert per tool + an architect), ask them questions, answer
their questions back, and let the group collaborate. Read this before changing
the IPC, the reply flow, or the busy/idle gating — a couple of pieces look
redundant but each fixes a specific correctness hazard (see [Gotchas](#gotchas)).

It is **deliberately separate** from `tmux-subagent.ts`: that extension owns
spawning/visibility (tmux windows, widgets, guardrails approval); this one owns
*messaging only*, so the spawn layer can change (e.g. go headless) without
touching how agents talk. The two compose but don't depend on each other.

## What it gives you

- **Tools** (available to every agent that loads the extension — fully
  bidirectional and peer-to-peer: orchestrator↔expert, expert↔expert):
  - `coms_list` — who's on the bus (name, purpose, model, live context%).
  - `coms_send(target, prompt, wait?, response_schema?, conversation_id?)` —
    ask one teammate. **Async by default**: returns a `msg_id` and the answer
    arrives later as a follow-up message. `wait:true` blocks and returns inline.
  - `coms_broadcast(targets, prompt, response_schema?)` — ask many at once;
    returns `{group_id, msg_ids}`; each answer arrives as its own follow-up.
    `targets:["*"]` fans out to the whole team.
  - `coms_poll(msg_id|group_id)` — non-blocking status of an async send/broadcast.
  - `coms_shutdown(targets, reason?)` — dismiss teammate(s) when the work is
    done; `targets:["*"]` dismisses the whole team (never yourself).
- **Command**: `/coms` — show the team pool + your inbox/pending counts.
- **Widget**: a team-pool card (project · you, inbox/pending, each peer with a
  live/stale dot, model, context%, queue depth).

## Activation (opt-in)

coms-bus lives in the global extensions dir, so pi **auto-loads it in every
session**. To avoid every ordinary session joining a bus, the extension is
**dormant by default**: it registers its CLI flags (so pi accepts them) and then
bails unless you explicitly opt in. When dormant it registers **no tools, no
widget, no registry entry, and no timers**.

It activates when any of these is present at launch:
`--coms` · `--cname <n>` · `--project <p>` · `--explicit` ·
`PI_COMS_CNAME` · `PI_COMS_PROJECT` (env) — **or** the `/coms-join` command at
runtime (no restart).

```bash
pi --coms                              # join the default project, auto name
pi --cname architect --project kb      # join team "kb" as "architect"
```

From inside a running (dormant or joined) session:

```
/coms-join writers-room as bob         # join team "writers-room" as "bob"
/coms-join                             # join the default project, auto name
/coms-leave                            # leave the bus (session keeps running)
```

> Flags are only parsed by the time `session_start` fires (`pi.getFlag()`
> returns `undefined` at module-load), so opt-in is evaluated in
> `session_start`, not at load. When dormant, the `coms_*` tools are
> **registered but deactivated** (`setActiveTools`) so they don't clutter a
> normal session; `/coms-join` activates them, `/coms-leave` hides them again.

## Identity & teams

Resolved at `session_start` from flags > env > defaults. pi owns `--name` (it
resumes it across sessions), so we use **`--cname`**:

| Flag | Env | Meaning |
|------|-----|---------|
| `--cname <name>` | `PI_COMS_CNAME` | addressable name on the bus |
| `--purpose <text>` | `PI_COMS_PURPOSE` | one-line role shown in `coms_list` |
| `--project <name>` | `PI_COMS_PROJECT` | **team namespace** (default `default`) |
| `--explicit` | — | hide from auto-discovery / `*` broadcast; only direct-addressable |
| `--color #RRGGBB` | — | widget colour (else palette fallback) |

A **project is the team**. Everyone launched with the same `--project` can see
and message each other by `--cname`. Name collisions with a live peer are
auto-suffixed (`architect-2`).

## Async-first (the important design choice)

`coms_send` defaults to **non-blocking**: it returns a `msg_id` and the reply is
delivered later as a follow-up message (the same mechanism `tmux-subagent` uses
for background results). This avoids a genuine **deadlock**: if an orchestrator
*blocks* awaiting expert A, and A asks the orchestrator a sub-question, both wait
forever. Async delivery lets turns interleave. `wait:true` exists as a blocking
convenience for simple leaf calls where the callee can't call back — the tool
description spells out the caveat.

## The two roles in one process

Every agent is simultaneously a **sender** (issues `coms_send`/`coms_broadcast`,
tracks replies in `pending`) and a **receiver** (services inbound prompts, ships
answers on `agent_end`). There is no central process — coordination is
**file-based IPC** under `~/.pi/coms-bus/` (override `PI_COMS_BUS_DIR`).

```
~/.pi/coms-bus/
  projects/<project>/
    agents/<cname>.json              registry entry (presence; pid + heartbeat)
    inbox/<cname>/<ts>-<msgid>.json  one file per message (prompt or response)
```

### Why this layout scales

- **Each agent watches only its own inbox dir** — one `fs.watch` + a 1s tick
  fallback. Watchers scale **linearly** (1/agent), never quadratically.
- **One file per message**, written atomically (temp file + `rename`), so
  multiple concurrent senders never corrupt a shared file.
- **Presence is pruned by PID liveness** (`process.kill(pid,0)`): a crashed
  agent's registry entry is removed the next time anyone lists the project.
- Filenames are timestamp-prefixed so `drainInbox` reads FIFO.

Practical envelope: **dozens** of agents on one host comfortably. Past ~100 the
O(N) registry scans and watcher fds start to matter; that's the trigger to move
to the Redis substrate (below).

## Message flow

```
sender                                   receiver
──────                                   ────────
coms_send / coms_broadcast
  resolveTarget(name|session)
  deliverMessage → inbox/<recv>/…json ─▶ fs.watch fires → onInboxChange
  register Pending{msg_id, promise}        drainInbox → push to inboundQueue
                                           serviceNextInbound (idle-gated):
                                             sendMessage(followUp, triggerTurn)
                                             set currentInbound
                                           LLM runs a turn, produces an answer
  resolveResponse  ◀── inbox/<send>/…json   agent_end → extract last assistant
  - resolve Pending.promise (for wait)        text → deliverMessage(response)
  - if not consumed: deliver follow-up        clear currentInbound
```

`response_schema` (if set on the prompt) asks the receiver to reply with JSON;
`agent_end` `JSON.parse`s the final assistant text and reports an `error` if it
isn't valid JSON.

Hop inheritance: a `coms_send` issued *while servicing an inbound* carries
`hops = inbound.hops + 1`; `MAX_HOPS` (default 5) caps relay chains.

## Lifecycle & teardown

A teammate is an ordinary long-lived pi session: it sits idle and only runs a
turn when a coms prompt arrives. It **leaves the bus when its process ends** —
`session_shutdown` (quit/reload/…) or `SIGINT`/`SIGTERM` runs `removeRegistry`
(deletes its registry file + inbox dir). A hard kill leaves a stale entry, which
PID-liveness pruning reaps on the next `coms_list`/widget render.

You shut a teammate down three ways:
1. **Locally** — end that session (`/exit`, `Ctrl-C`, or kill its tmux window).
2. **Remotely** — `coms_shutdown(targets|["*"])`. This delivers a
   `kind:"control"` / `control:"shutdown"` message; the receiver drains it,
   shows a toast, and calls `ctx.shutdown()` on the next tick (50ms) so the
   drain + any in-flight reply finish first. `ctx.shutdown()` fires
   `session_shutdown`, so cleanup is the same as a local exit. `coms_shutdown`
   never targets the caller.
3. **Crash** — pruned automatically (above).

> Note: `coms_shutdown` only works on agents that stay alive as listeners
> (their own pi sessions). `tmux-subagent`'s `launch_agent` is task-then-done
> and kills the pane on `agent_end`, so it doesn't host persistent listeners —
> that's the integration still to come (`coms_launch_team` + auto-enroll).

## Busy/idle gating (correctness, not optimization)

A coms prompt is handed to the LLM **only when the agent is idle**, tracked by a
`busy` flag (`turn_start` → busy, `agent_end` → idle). `currentInbound` is set at
that moment, so the **next** `agent_end` is unambiguously the reply to that
prompt. Without this, a coms prompt arriving mid-turn (e.g. during a human turn)
would set `currentInbound`, and that unrelated turn's `agent_end` would
mis-ship its output back as the coms answer. Prompts that arrive while busy wait
in `inboundQueue` and are serviced one at a time after each `agent_end`.

## Gotchas

1. **Idle-gate before setting `currentInbound`.** See above — this is the one
   non-obvious invariant. `agent_end` clears `busy` first, then either ships the
   reply (coms turn) or just tries to service the next queued prompt.
2. **`-p` (print mode) can't host a listener.** pi `-p` exits the instant its
   CLI turn ends, aborting any turn a coms prompt triggers. Test listeners in a
   persistent session (interactive / tmux), which is the real deployment.
3. **Clean shutdown removes the registry entry**; a hard kill leaves it, but
   PID-liveness pruning reaps it on the next `coms_list`/widget render.
4. **`os` tmp vs `~/.pi`** — unlike `tmux-subagent` (ephemeral `$TMPDIR`),
   coms-bus lives under `~/.pi/coms-bus` so presence persists across a session's
   lifetime and is easy to inspect. Inbox files are transient (consumed on read).
5. **Substrate is isolated.** Everything between the `SUBSTRATE` banners is the
   only code that changes for Redis. The tool surface above is substrate-agnostic.

## Future: Redis substrate (via podman)

The planned upgrade for cross-host or hundreds of agents is to swap the file-IPC
substrate for Redis (run as a lightweight **podman** container, not Docker
Desktop). The tool surface stays identical. Mapping:

| File-IPC piece | Redis primitive |
|----------------|-----------------|
| inbox dir + `fs.watch` | `SUBSCRIBE` / Streams `XREAD BLOCK` (true push) |
| `pending` + reply file | reply on a `msg_id` channel; `BLPOP` for `wait` |
| `agents/*.json` + PID prune | `SET agent:<n> … EX 15` + heartbeat (TTL = presence) |
| `coms_broadcast` fan-out | one `PUBLISH team:<x>` |
| `coms_shutdown` control msg | `PUBLISH agent:<n>:control` |

The extension must **degrade gracefully** when the container is down (clear
"start the bus" message) so a stopped Redis never breaks a normal pi session.

## Quick manual test

```bash
# terminal 1 — a listener teammate
pi -e config/pi/extensions/coms-bus.ts --cname listener --project demo

# terminal 2 — the asker
pi -e config/pi/extensions/coms-bus.ts --cname asker --project demo
# then in the asker:  coms_send(target:"listener", prompt:"reply PONG", wait:true)
```
`coms_list` from either side shows the other; the answer round-trips back.

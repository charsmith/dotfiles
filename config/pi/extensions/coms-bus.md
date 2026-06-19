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
  - `coms_send(target, prompt, response_schema?, conversation_id?)` —
    ask one teammate. **Always async**: returns a `msg_id` and the answer
    arrives later as a follow-up message (it never blocks). Use `coms_poll` for
    status. You do **not** use this to reply to a question someone asked you —
    just write your answer as normal text (see Reply correlation).
  - `coms_broadcast(targets, prompt, response_schema?)` — ask many at once;
    returns `{group_id, msg_ids}`; each answer arrives as its own follow-up.
    `targets:["*"]` fans out to the whole team.
  - `coms_poll(msg_id|group_id)` — non-blocking status of an async send/broadcast.
  - `coms_shutdown(targets, reason?)` — dismiss teammate(s) when the work is
    done; `targets:["*"]` dismisses the whole team (never yourself).
- **Commands**:
  - `/coms` — show the team pool + your inbox/pending counts.
  - `/coms-join [team] [as <name>]` / `/coms-leave` — join/leave at runtime.
  - `/team-down [project]` — dismiss a whole team (lists teams if more than one);
    graceful shutdown + a SIGTERM→SIGKILL pid-kill backstop. Works even from a
    session that never joined the bus.
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
forever. Async delivery lets turns interleave. There is intentionally **no blocking
send** — an earlier `wait:true` option was removed because it reintroduced
exactly this deadlock (plus a simpler hang: a *reply* never gets replied to, so a
blocking send waiting on one hung forever). Every send returns immediately; poll
with `coms_poll` if you need status.

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
- Filenames are timestamp-prefixed so `claimInbox` reads FIFO.

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
  register Pending{msg_id}                 claimInbox → rename .inflight, queue
                                           serviceNextInbound (idle-gated):
                                             sendMessage(followUp, triggerTurn)
                                             set currentInbound
                                           LLM runs a turn, produces an answer
  resolveResponse  ◀── inbox/<send>/…json   agent_end → extract last assistant
  - record Pending.result (for coms_poll)     text → shipResponse(msg_id)
  - deliver answer as a follow-up             ackPrompt (delete .inflight)
```

`response_schema` (if set on the prompt) asks the receiver to reply with JSON;
`agent_end` `JSON.parse`s the final assistant text and reports an `error` if it
isn't valid JSON.

Hop inheritance: a `coms_send` issued *while servicing an inbound* carries
`hops = inbound.hops + 1`; `MAX_HOPS` (default 5) caps relay chains.

## Reply correlation (answer in plain text)

A reply is shipped **only** by the `agent_end` hook: when a member finishes the
turn that serviced an inbound prompt, its final assistant text is delivered back
as a `response` carrying the **original `msg_id`**, which resolves the asker's
`pending` slot. So a member must *just write its answer as normal text*.

The footgun this avoids: replying with `coms_send` opens a **new** thread (new
`msg_id`), so the asker's request never resolves and it polls `pending` forever
(this wedged a real team in testing). Two defenses:
- the inbound prompt injected to the LLM says explicitly *"answer in plain text,
  don't call coms_send to reply"*, and
- `coms_send` has a **safety net**: a send to the teammate you're *currently
  servicing* is re-routed via `shipResponse` as the proper answer (same
  `msg_id`); `agent_end` then sees `currentInbound===null` and won't double-reply.
  Sending to any *other* teammate mid-turn stays a normal new ask.

## Durability (crash-safe inbox)

A member can be killed mid-answer (`/team-down`, a manual kill, or a crash) and
respawned — its unanswered question must not be lost. The inbox is a **two-phase
ack**:

1. **Claim** — `claimInbox` renames a serviced prompt `‹file›.json` →
   `‹file›.json.inflight` instead of deleting it.
2. **Ack** — `ackPrompt` deletes the `.inflight` file only after the reply has
   shipped (inside `shipResponse`).
3. **Recover** — on join, `recoverInflight` re-queues any leftover `.inflight`
   files (a previous run died after claiming, before acking).

`removeRegistry` **keeps a non-empty inbox** so the `.inflight` survives the
death. And `serviceNextInbound` **re-queues** (never drops) a prompt if
`pi.sendMessage` throws "already processing" — a respawned member's warmup turn
can race recovery, so the recovered prompt is retried at the next idle /
`agent_end` instead of being lost. Net effect: at-least-once delivery with crash
recovery. Verified live (kill the moment a helper logs `inbound_prompt` but
before `outbound_response`, respawn same `--cname` → it logs `recovered_prompt`
and answers the same `msg_id`). Responses/control remain delete-on-read.

## Lifecycle & teardown

A teammate is an ordinary long-lived pi session: it sits idle and only runs a
turn when a coms prompt arrives. It **leaves the bus when its process ends** —
`session_shutdown` (quit/reload/…) or `SIGINT`/`SIGTERM` runs `removeRegistry`,
which deletes its registry file but **keeps a non-empty inbox** so a respawn with
the same `--cname` can recover unanswered work (see Durability). A hard kill
leaves a stale entry, which PID-liveness pruning reaps on the next
`coms_list`/widget render.

You shut a teammate down four ways:
1. **Locally** — end that session (`/exit`, `Ctrl-C`, or kill its tmux window).
2. **Remotely (by an agent)** — `coms_shutdown(targets|["*"])`: delivers a
   `kind:"control"` / `control:"shutdown"` message; the receiver drains it,
   shows a toast, and calls `ctx.shutdown()` on the next tick (50ms) so the
   drain + any in-flight reply finish first. Never targets the caller.
3. **By the human** — `/team-down [project]`: the same control-message broadcast
   to every member, then a **SIGTERM→SIGKILL pid-kill backstop** (the registry
   stores each pid) + inbox purge for anything that ignores the graceful signal.
   Lists teams if more than one; works even from a session that never joined the
   bus (`identity` may be null).
4. **Crash** — pruned automatically (above).

> Integration with `tmux-subagent`: `launch_agent(team:"<project>", ...)` spawns
> a **persistent** member that auto-joins via `PI_COMS_PROJECT`/`PI_COMS_CNAME`
> env and stays alive as a listener. When such a member exits, `tmux-subagent`
> **suppresses** the usual "finished" follow-up (its real output went over coms)
> and shows only a quiet toast — so `/team-down` teardown isn't noisy.

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
   lifetime and is easy to inspect. Prompt files are **claimed, not consumed**:
   a serviced prompt becomes `<file>.inflight` and is deleted only after the
   reply ships (durability); responses/control are delete-on-read.
5. **Substrate is isolated.** Everything between the `SUBSTRATE` banners is the
   only code that changes for Redis. The tool surface above is substrate-agnostic.

## Future: Redis substrate (via podman)

The planned upgrade for cross-host or hundreds of agents is to swap the file-IPC
substrate for Redis (run as a lightweight **podman** container, not Docker
Desktop). The tool surface stays identical. Mapping:

| File-IPC piece | Redis primitive |
|----------------|-----------------|
| inbox dir + `fs.watch` | `SUBSCRIBE` / Streams `XREAD BLOCK` (true push) |
| `pending` + reply file | reply on a `msg_id` channel (follow-up delivery) |
| `.inflight` claim + `ackPrompt` | Stream consumer-group `XREADGROUP` + `XACK` |
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
# then in the asker:  coms_send(target:"listener", prompt:"reply PONG")
# the answer arrives as a follow-up; coms_poll("<msg_id>") to check status
```
`coms_list` from either side shows the other; the answer round-trips back.

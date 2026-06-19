# coms-bus repro + verification harness

Reproduce the two-agent exchange that wedged in testing, and assert correctness
with `coms-check.py`. Companion to `coms-bus.ts` / `coms-bus.md`.

## The bug this catches

A support agent (`b`) answered its asker (`a`) by **calling `coms_send` back to
`a`** instead of just writing its answer. That opens a *new* thread (new msg_id),
so `a`'s original request never resolves — `coms_poll` shows `pending` forever and
the team wedges. Found by reading session logs; `coms-check.py` automates that.

Fix under test (`coms-bus.ts`):
1. The injected inbound prompt now says explicitly: *answer in plain text, don't
   call `coms_send` to reply.*
2. `coms_send` safety net: if the agent sends to the teammate it is **currently
   answering**, it is re-routed as the proper `response` (same msg_id).

## Live repro (after a `/reload` so the edited extension is loaded)

From an orchestrator pi session on the bus (`pi --coms --project reprotest --cname boss`),
or by driving `launch_agent(team:"reprotest", ...)`:

1. Launch the helper `b`:
   - `launch_agent(name:"helper", team:"reprotest", system_prompt:"You answer the
     asker's questions concisely. Stay alive.", task:"warm up")`
2. Launch the asker `a` with a persona that **must** consult `b`:
   - `launch_agent(name:"asker", team:"reprotest", system_prompt:"Ask the teammate
     named 'helper' one question via coms_send, then report its answer.",
     task:"Ask helper: what is 2+2? Report the reply.")`
3. Watch both tmux windows. Expected now:
   - `helper` receives `[coms · question from asker]`, writes a plain-text answer,
     ends its turn → `agent_end` ships the `response`.
   - `asker`'s async `coms_send` resolves; the answer arrives as a follow-up.
   - If `helper` *does* call `coms_send` back to `asker`, the safety net re-routes
     it — `asker` still resolves (no wedge).
4. Tear down: `/team-down reprotest` (once implemented) or `coms_shutdown(["*"])`.

## Assert with the checker

Point `coms-check.py` at the two child sessions (newest in the project's session
dir) — or the whole dir:

```bash
SESS=~/.config/pi/sessions/--Users-charsmith--          # your project's dir
python3 ~/.config/pi/extensions/test/coms-check.py "$SESS"
```

- Exit 0 + `✓ correlation clean` → reply path is correct.
- Exit 1 + `REPLY-VIA-SEND` / `UNANSWERED` → the wedge is still present.

Regression fixture: the original failing run is preserved under the
`dp-knowledge-base` session dir (sessions `019ee0ca-429b` + `019ee0ca-d2dd`);
running the checker over those two must still report `REPLY-VIA-SEND` +
`UNANSWERED` (proves the checker detects the bug).

## #2 durability — DONE + verified live

Mechanism: prompts are claimed by renaming to `<file>.inflight` (not deleted),
deleted only after the reply ships (`ackPrompt`); `removeRegistry` keeps a
non-empty inbox; on join, `recoverInflight` re-queues leftover `.inflight` files.
`serviceNextInbound` re-queues (not drops) if pi is still processing, so the
startup warmup turn can't lose a recovered prompt.

Live test that proved it: launch `helper` + `asker`, kill `helper` the instant its
session logs `inbound_prompt` (claimed) but before `outbound_response`, then
respawn `helper` with the same cname. Result: respawned helper logged
`recovered_prompt` + `outbound_response` for the SAME msg_id, asker got its
`inbound_response`, and `coms-check.py` reported `✓ correlation clean` +
`recovered after restart: 1 prompt`.

To catch the kill window, poll the helper session jsonl:
```bash
HF=<helper-session>.jsonl
until grep -q inbound_prompt "$HF"; do sleep 0.2; done
grep -q outbound_response "$HF" || tmux kill-window -t <helper-window>
```

## Still TODO

- **#3 `/team-down`** human teardown + pid-kill backstop — implemented; needs a
  `/reload` to test live (use it instead of hand-killing windows).
- **#4** drop/neuter `coms_send wait:true`.

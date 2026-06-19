#!/usr/bin/env python3
"""
coms-check — verify coms-bus request/response correlation from session logs.

Automates the manual diagnosis that found the "reply-via-coms_send" bug: it reads
the `coms-bus-log` custom entries that coms-bus.ts writes into each pi session
.jsonl and checks, across all sessions, that every prompt got a correlated
response and that nobody replied to their asker by opening a new thread.

Usage:
    coms-check.py <session-dir-or-files...>

    # whole project session dir:
    coms-check.py ~/.config/pi/sessions/--Users-me-proj--/

Exit code 0 = clean, 1 = problems found. Designed to be the assertion step of a
live two-agent repro (see coms-repro.md): launch a + b, drive one exchange, run
this over their two session files.
"""
import sys, os, json, glob

# Event shapes written by coms-bus.ts (pi.appendEntry "coms-bus-log"):
#   join / leave            {name, [project], session_id}
#   inbound_prompt          {msg_id, from, hops}          (we received a question)
#   outbound_prompt         {msg_id, to, group_id, hops}  (we asked someone)
#   outbound_response       {msg_id, to, error}           (we answered a question)
#   inbound_response        {msg_id, from, error}         (an answer came back)
#   response_drop_offline   {msg_id, to}                  (asker had vanished)

def load_events(files):
    evs = []
    for f in files:
        try:
            sid = os.path.basename(f)
            for line in open(f):
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except Exception:
                    continue
                if o.get("customType") != "coms-bus-log":
                    continue
                d = dict(o.get("data") or {})
                d["_ts"] = o.get("timestamp", "")
                d["_file"] = sid
                evs.append(d)
        except OSError:
            pass
    evs.sort(key=lambda e: e.get("_ts", ""))
    return evs


def expand(paths):
    files = []
    for p in paths:
        if os.path.isdir(p):
            files += glob.glob(os.path.join(p, "*.jsonl"))
        else:
            files += glob.glob(p)
    return sorted(set(files))


def main(argv):
    files = expand(argv[1:] or ["."])
    if not files:
        print("no session files found", file=sys.stderr)
        return 1
    evs = load_events(files)
    if not evs:
        print("no coms-bus-log events found in those sessions", file=sys.stderr)
        return 1

    prompts_out = {}   # msg_id -> outbound_prompt event (someone asked)
    responses = {}     # msg_id -> outbound_response event (someone answered)
    inbound = {}       # msg_id -> inbound_prompt event (someone received)
    # per-file: did this session reply-via-send? (had inbound from Y, then
    # outbound_prompt to Y, never outbound_response for that msg_id)
    per_file_inbound_from = {}  # file -> {from_name: [msg_id,...]}
    per_file_sent_to = {}       # file -> set(to_name)
    per_file_responded = {}     # file -> set(msg_id)

    for e in evs:
        ev, f = e.get("event"), e.get("_file")
        if ev == "outbound_prompt":
            prompts_out[e["msg_id"]] = e
        elif ev == "outbound_response":
            responses[e["msg_id"]] = e
            per_file_responded.setdefault(f, set()).add(e["msg_id"])
            per_file_sent_to.setdefault(f, set()).add(e.get("to"))
        elif ev == "inbound_prompt":
            inbound[e["msg_id"]] = e
            per_file_inbound_from.setdefault(f, {}).setdefault(e.get("from"), []).append(e["msg_id"])

    problems = []

    # 1. Unanswered prompts: someone asked, no correlated response came back.
    for mid, p in prompts_out.items():
        if mid not in responses:
            problems.append(f"UNANSWERED: prompt {mid} \u2192 {p.get('to')} never got an outbound_response (asker would poll 'pending' forever)")

    # 2. Reply-via-send: a session received a question from Y, then sent a NEW
    #    prompt to Y, and never produced a response for the original msg_id.
    for f, froms in per_file_inbound_from.items():
        sent_to = per_file_sent_to.get(f, set())
        responded = per_file_responded.get(f, set())
        for y, mids in froms.items():
            unresolved = [m for m in mids if m not in responded]
            if y in sent_to and unresolved:
                problems.append(
                    f"REPLY-VIA-SEND: {os.path.basename(f)} got question(s) {unresolved} from '{y}' "
                    f"then opened a NEW thread to '{y}' instead of answering (the wedge bug)")

    # 3. Dropped responses (asker offline at reply time).
    for e in evs:
        if e.get("event") == "response_drop_offline":
            problems.append(f"DROPPED: response for {e.get('msg_id')} \u2192 {e.get('to')} (asker had left the bus)")

    recovered = [e for e in evs if e.get("event") == "recovered_prompt"]

    # Report
    print(f"scanned {len(files)} session file(s), {len(evs)} coms event(s)")
    if recovered:
        print(f"  recovered after restart: {len(recovered)} prompt(s) re-claimed on join "
              + "(" + ", ".join(e.get("msg_id", "?") for e in recovered) + ")")
    print(f"  prompts sent: {len(prompts_out)}   responses sent: {len(responses)}   inbound received: {len(inbound)}")
    if not problems:
        print("\u2713 correlation clean: every prompt answered, no reply-via-send, no drops")
        return 0
    print(f"\u2717 {len(problems)} problem(s):")
    for p in problems:
        print("  - " + p)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

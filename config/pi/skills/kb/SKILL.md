---
name: kb
description: >
  Query frontmatter and body content from the dp-knowledge-base using the `kb`
  CLI. Use for listing tools/research/docs entries, filtering by frontmatter
  field (exact, substring, or regex operators), reading individual entries
  (frontmatter + body preview), navigating entry structure (outline, section,
  files), fetching single field values, inspecting app identity/ownership/status
  profiles, browsing schema and value distributions, finding entries with
  missing fields, and viewing security hardening posture via `kb readiness`.
  Brainstorm subdirectories are fully supported alongside flat .md files.
  Supports named search aliases (e.g. `apex`, `ddx`) that expand into filter
  expressions. Prefer `kb` over reading vault files directly.
  `kb grep` requires ripgrep (`brew install ripgrep`). `kb read` and `kb app`
  without a name argument require fzf (`brew install fzf`).
compatibility: kb CLI (uv tool install --editable .), dp-knowledge-base vault
metadata:
  owners:
    - charsmith@netflix.com
  status: personal
  category: data-platform
  tags:
    - kb
    - knowledge-base
    - frontmatter
    - data-platform
allowed-tools:
  - "Bash(kb *)"
---

# kb — dp-knowledge-base CLI

`kb` is a personal CLI for querying the dp-knowledge-base vault. It reads YAML
frontmatter (and a header-convention fallback for `docs/`) from Markdown files
and lets you list, filter, read, audit, and navigate entries. Set `KB_ROOT` to
override the default vault path (`/Users/charsmith/Documents/the_vault/dp-knowledge-base`).

## Quick Reference

```bash
# ── List ────────────────────────────────────────────────────────────────────
kb list                          # rich table of all tools
kb list --json                   # JSON array
kb list --plain                  # tab-separated (pipeable)
kb list --dir research --json    # research entries

# ── Search ─────────────────────────────────────────────────────────────────
kb search category=deployment            # exact match
kb search type~oss                       # substring match
kb search team:Orchestration             # regex match
kb search category=deployment team=delivery --json
kb search apex                           # alias → dp_org_owner~"Analytics Platform"
kb search audience=engineers --dir research

# ── App profile ────────────────────────────────────────────────────────────
kb app maestro                   # identity/ownership/status panels
kb app maestro --json            # structured JSON

# ── Read / navigate ────────────────────────────────────────────────────────
kb read spinnaker                # frontmatter + up to 60 body lines
kb outline maestro               # heading tree
kb outline maestro --depth 2     # top-level headings only
kb section maestro "Auth"        # body of the section matching "Auth"
kb files maestro                 # all .md files in the maestro directory

# ── Field access ───────────────────────────────────────────────────────────
kb get maestro repo              # single field value
kb get maestro team --json
kb values type                   # frequency table for a field
kb values dp_org_owner

# ── Body search ────────────────────────────────────────────────────────────
kb grep Kafka --dir tools        # ripgrep across all tool bodies
kb grep kafka -i --entry maestro # case-insensitive, restricted to one entry
kb grep Kafka -c                 # count only

# ── Schema / aliases ───────────────────────────────────────────────────────
kb schema                        # render SPEC.md for tools
kb schema --json                 # JSON list of field objects
kb aliases                       # show all configured aliases

# ── Audit ──────────────────────────────────────────────────────────────────
kb missing cloned
kb missing date --dir research --json

# ── Security readiness ──────────────────────────────────────────────────────
kb readiness                         # fleet view: all tools with security.md
kb readiness maestro                 # single service panel
kb readiness --ring 0                # Ring 0 tools only
kb readiness apex                    # filter by alias
kb readiness --json                  # machine-readable
```

## Commands

### `kb list`

```
kb list [--dir tools|research|docs|brainstorm] [--json] [--plain] [--format table|json]
```

Lists all entries in a knowledge-base directory. Defaults: `--dir tools`.

**Display columns per directory:**

| Directory | Columns shown |
|-----------|---------------|
| `tools` | `service`, `category`, `type`, `cloned`, `language`, `team` |
| `research` | path, `question`, `date`, `audience`, `sources` |
| `docs` | path, `title`, `date` (header-convention fallback) |
| `brainstorm` | path + all frontmatter keys present (flat `.md` files **and** named subdirectories — same primary-file precedence as research: `overview.md` → `<dirname>.md` → first alphabetically) |

**Example — tools JSON (one entry):**
```json
[
  {
    "name": "spinnaker",
    "dir_kind": "tools",
    "frontmatter": {
      "service": "spinnaker",
      "category": "deployment",
      "type": "orchestration",
      "cloned": "true",
      "language": "java",
      "team": "delivery"
    },
    "body": "..."
  }
]
```

---

### `kb search`

```
kb search <filter> ... [--dir tools|research|docs] [--json] [--plain] [--format table|json]
```

Filters entries by one or more filter expressions (AND semantics). Alias tokens
from `kb.yaml` are expanded before parsing. Defaults: `--dir tools`.

#### Filter operators

| Syntax | Semantics |
|--------|-----------|
| `field=value` | Case-insensitive exact equality. List-valued fields match when `value` appears anywhere in the list. |
| `field~pattern` | Case-insensitive substring match (`pattern in value`). |
| `field:pattern` | Regex match (`re.search(pattern, value, re.IGNORECASE)`; `re.DOTALL` is **not** set). |

#### Aliases

Aliases are short tokens defined in `kb.yaml` that expand to one or more filter
expressions. Use `kb aliases` to list them. Example: `apex` expands to
`dp_org_owner~"Analytics Platform"`, so `kb search apex` returns all Analytics
Platform tools.

**Real field names per directory:**

- **tools**: `service`, `category`, `type`, `repo`, `cloned`, `language`, `team`,
  `owning_org`, `dp_org_owner`, `spinnaker_app_name`, `deep`, `is_control_plane`,
  `gagan_report`, `prashanth_report`, `human_commits_jan_apr`, `llm_commits_jan_apr`,
  `llm_type`, `top_committers`, `spof`
- **research**: `question`, `date`, `sources`, `audience`, `repos`
- **docs**: `title`, `date`, `source` (parsed from header convention)

```bash
kb search category=deployment              # exact
kb search type~oss                         # substring
kb search team:Orchestration               # regex
kb search apex                             # alias
kb search category=deployment team=delivery --json
kb search audience=engineers --dir research
```

---

### `kb app`

```
kb app [NAME] [--json] [--plain]
```

Displays a structured profile for a tool entry in three panels. Only searches
the `tools` directory. When `NAME` is omitted, launches **fzf** for interactive
selection (requires `brew install fzf`).

**Panels:**

| Panel | Fields |
|-------|--------|
| **Identity** | `name`, `type`, `repo`, `spinnaker_app_name` |
| **Ownership** | `team`, `owning_org`, `dp_org_owner` |
| **Status** | `deep`, `cloned`, `is_control_plane` |

**`--json` shape:**
```json
{
  "identity": {
    "name": "maestro",
    "type": "service",
    "repo": "https://git.netflix.net/corp/bdp-maestro",
    "spinnaker_app_name": "maestro"
  },
  "ownership": {
    "team": "Orchestration (Marcelo Mayworm)",
    "owning_org": "Data Platform (Prashanth Ramdas)",
    "dp_org_owner": "Analytics Platform and Experience (Anjali Norwood)"
  },
  "status": {
    "deep": true,
    "cloned": "~/code/nflx/bdp-maestro",
    "is_control_plane": true
  }
}
```

---

### `kb read`

```
kb read <name> [--dir tools|research|docs] [--json] [--plain]
```

Prints frontmatter as YAML followed by up to 60 lines of the entry body.
`<name>` is the directory name (tools/research) or filename stem (docs).
Exits non-zero if the entry is not found. When `NAME` is omitted, launches
**fzf** for interactive selection (requires `brew install fzf`).

```bash
kb read spinnaker
kb read maestro --dir research
```

**Example output:**
```
category: deployment
cloned: 'true'
language: java
service: spinnaker
team: delivery
type: orchestration
---
# Spinnaker

Spinnaker is a multi-cloud continuous delivery platform ...
```

---

### `kb outline`

```
kb outline <name> [--dir tools|research|docs] [--depth <int>] [--json] [--plain]
```

Prints a heading outline (tree of `#`/`##`/… headings) for an entry.
Default `--depth` is 6 (all levels). Useful for discovering what sections an
entry has before calling `kb section`.

```bash
kb outline maestro               # full heading tree
kb outline maestro --depth 2     # top two levels only
kb outline maestro --json        # JSON list of {level, text} objects
```

**Example output (plain):**
```
# Maestro — Overview
  ## What the Service Does
  ## Production Hostnames and Eureka App Names
  ## Auth Mechanism
    ### Layer 1 — Metatron mTLS (Identity)
    ### Layer 2 — Gandalf RBAC (Authorization)
```

---

### `kb section`

```
kb section <name> <header> [--dir tools|research|docs] [--json]
```

Prints the body of the first section whose heading contains `<header>` as a
substring (case-insensitive). The section runs from the matched heading to the
next heading at the same or higher level.

```bash
kb section maestro "Auth"        # section whose heading contains "Auth"
kb section maestro overview --json
```

---

### `kb files`

```
kb files <name> [--dir tools|brainstorm] [--json] [--plain]
```

Lists all `.md` files inside an entry's directory. Works for both `tools` and
`brainstorm` directories; exits 1 with a helpful message for other directories.
Displays name, line count, and full path. Useful when an entry has multiple
sub-documents (e.g. `overview`, `security`, `services`).

```bash
kb files maestro                 # rich table of .md files
kb files maestro --json          # JSON list of {name, lines, path}
```

**Example output:**
```
name            lines  path
overview          445  .../maestro/overview.md
security           63  .../maestro/security.md
services          127  .../maestro/services.md
```

---

### `kb readiness`

```
kb readiness [NAME] [--ring N] [--json] [--plain]
```

Shows security hardening posture for tool services. Reads `security.md`
frontmatter from `tools/<service>/` directories. Only tools that have a
`security.md` with YAML frontmatter appear in the output.

**Output modes:**
- **Single match** (by name or alias) → Rich panel with L1–L6 symbols, ICFD,
  WFS registered, SCRUB App Ingress, and Key Gap.
- **Fleet / multiple matches** → Rich table sorted by ring then severity
  (critical → warning → fail → pass → unassessed).

**L-level symbols:** ✅ `pass` · ⚠️ `warning` · 🔴 `critical` · ❌ `fail` · — `unassessed`

**Live fields shown:** `icfd` (compliant|non-compliant|unassessed),
`wfs_registered` (bool), `scrub_app_ingress` (bool).

**Filter options:**

| Argument | Effect |
|----------|--------|
| `--ring N` | Restrict to ring 0–3 |
| `NAME` | Service name (fuzzy) or alias (`apex`, `dataplatform`, etc.) |
| `dataplatform` | All DP tools (full fleet after `--ring` filter) |

**`--json` shape (one object per entry):**
```json
[
  {
    "name": "maestro",
    "ring": 1,
    "l1": "pass", "l2": "pass", "l3": "warning", "l4": "unassessed",
    "l5": "unassessed", "l6": "unassessed",
    "icfd": "compliant",
    "wfs_registered": true,
    "scrub_app_ingress": false,
    "key_gap": "No SCRUB app-ingress check",
    "p0": false,
    "assessed_at": "2025-06-01",
    "live_data_checked_at": "2025-06-15"
  }
]
```

**Dataclass:** `ReadinessEntry` (frozen) — fields: `name`, `ring`, `l1`–`l6`,
`icfd`, `wfs_registered`, `scrub_app_ingress`, `key_gap`, `p0`, `assessed_at`,
`live_data_checked_at`. Missing L-levels default to `"unassessed"`.

```bash
kb readiness                        # fleet view
kb readiness maestro                # single service panel
kb readiness --ring 0               # Ring 0 tools only
kb readiness apex                   # alias → Analytics Platform tools
kb readiness dataplatform           # all DP tools
kb readiness --json                 # [{name, ring, l1..l6, ...}]
kb readiness --plain                # name\tring\tl1..l6\tkey_gap
```


---

### `kb get`

```
kb get <name> <field> [--dir tools|research|docs] [--json]
```

Prints the value of a single frontmatter field. Uses fuzzy name resolution.
Exits 0 with no output when the field is absent. Lists are printed one element
per line in plain mode.

```bash
kb get maestro repo              # prints the repo URL
kb get maestro team --json       # {"field": "team", "value": "Orchestration (...)"}
```

---

### `kb grep`

```
kb grep <pattern> [--dir tools|research|docs] [-i] [--entry <name>]
        [--max <n>] [-c] [--json] [--plain]
```

Searches entry bodies via **ripgrep** with heading-path context. Requires
`brew install ripgrep`. Each match is returned with the heading breadcrumb path
where it appeared.

| Option | Meaning |
|--------|---------|
| `-i` / `--ignore-case` | Case-insensitive match |
| `--entry <name>` | Restrict search to one entry |
| `--max <n>` | Stop after N matches |
| `-c` / `--count` | Print count only |

```bash
kb grep Kafka --dir tools        # all tool entries mentioning Kafka
kb grep kafka -i --entry maestro # case-insensitive, maestro only
kb grep Kafka -c                 # total match count
kb grep "Eureka" --json          # structured match objects
```

---

### `kb values`

```
kb values <field> [--dir tools|research|docs] [--json] [--plain]
```

Shows a frequency table of all values for a frontmatter field. Entries where
the field is absent are counted under `(missing)`.

```bash
kb values type                   # rich table: value → count
kb values dp_org_owner
kb values type --json            # [{"value": "service", "count": 122}, ...]
```

**Example output:**
```
value       count
service       122
library        26
config         10
(missing)       5
```

---

### `kb schema`

```
kb schema [--dir tools|research|docs] [--json] [--plain]
```

Displays the frontmatter schema for a directory. Reads `SPEC.md` from the
target directory and renders it as Rich Markdown by default, a JSON list of
field objects with `--json`, or one field name per line with `--plain`.

```bash
kb schema                        # render tools SPEC.md
kb schema --json                 # JSON list of field objects
kb schema --plain                # one field name per line
```

**`--json` shape (one object per field):**
```json
[
  {"field": "name",   "required": true,  "type_hint": "service-name",  "description": "short kebab-case identifier"},
  {"field": "type",   "required": true,  "type_hint": "see Type Values","description": ""},
  {"field": "repo",   "required": true,  "type_hint": "https://github.netflix.net/…", "description": "full HTTPS URL; null if no accessible repo"},
  {"field": "cloned", "required": true,  "type_hint": "~/code/…|null", "description": "actual local path, or null if not cloned"}
]
```

---

### `kb aliases`

```
kb aliases [--json] [--plain]
```

Lists all configured search aliases from `kb.yaml`. Shows an empty table when
no `kb.yaml` is found.

```bash
kb aliases                       # rich table: alias → filter expression
kb aliases --json
```

**Current aliases:**

| Alias | Expands to |
|-------|-----------|
| `apex` | `dp_org_owner~"Analytics Platform"` |
| `bdo` | `dp_org_owner~BDO` |
| `ddx` | `dp_org_owner~DDX` |
| `engines` | `dp_org_owner~"Engines and DSI"` |
| `lakehouse` | `dp_org_owner~Lakehouse` |

---

### `kb missing`

```
kb missing <field> [--dir tools|research|docs] [--json] [--plain] [--format table|json]
```

Lists entries where the specified frontmatter field is absent, `null`, or empty.
Useful for auditing vault completeness. Defaults: `--dir tools`.

```bash
kb missing cloned
kb missing date --dir research --json
kb missing title --dir docs
kb missing cloned --plain | wc -l
```

---

## Output Format

| Flag | Output | Use when |
|------|--------|----------|
| `--json` | Pretty-printed JSON array (list/search/missing) or object (read/app/get) | Processing output in jq, LLM agents, scripts |
| `--plain` | Tab-separated, no colour | Piping to `wc`, `awk`, `grep`, `sort` |
| `--format table\|json` | Rich table or JSON | Backwards-compatible alias; `--json`/`--plain` take precedence |

Precedence: `--json` > `--plain` > `--format`.

JSON output is `dataclasses.asdict()` — fully structured, stable field names.

```bash
kb list --json | jq '.[].frontmatter.team' | sort -u
kb search category=deployment --json | jq 'length'
kb missing cloned --json | jq '.[].name'
kb missing cloned --plain | wc -l
kb read spinnaker --json | jq '.frontmatter.team'
kb app maestro --json | jq '.ownership'
```

## External Dependencies

| Tool | Commands that need it | Install |
|------|-----------------------|---------|
| **ripgrep** (`rg`) | `kb grep` | `brew install ripgrep` |
| **fzf** | `kb read` (no name), `kb app` (no name) | `brew install fzf` |

---

## Sessions — Isolated Multi-change Workflows

Sessions let you make several `kb patch` calls in an isolated git worktree and
merge them to `main` as a single reviewed commit.

### Session rule for agents

> **If your task requires more than one `kb patch` call, always start a session
> first.** This prevents partial commits landing on `main`.

```bash
export KB_SESSION=$(kb session start my-task)

kb patch maestro type=service
kb patch ablaze team="Delivery"

kb session commit "batch metadata update"
```

### `KB_SESSION` env var

Set `KB_SESSION` to a branch name to pin the current process to a session:

```bash
export KB_SESSION=$(kb session start my-task)   # start + capture branch name
# ... run kb patch calls ...
kb session commit "done"                         # or: kb session abort
unset KB_SESSION
```

### Session resolution order

1. `KB_SESSION` environment variable
2. `.kb/current-session` file at the vault root
3. No session → commands operate on main vault directly

### `kb session` subcommands

```
kb session start [--name NAME]      # create worktree + branch; prints branch name
kb session list                     # list all active sessions (branch, changes, age)
kb session status                   # KB-semantic view of changed entries in session
kb session diff [NAME]              # full diff vs main for active or named session
kb session commit MESSAGE           # merge to main, clean up worktree + branch
kb session abort                    # discard session without merging
```

```bash
kb session start --name mywork
export KB_SESSION=$(kb session start pipeline-update)
kb session list
kb session status
kb session diff
kb session commit "update pipeline tools metadata"
kb session abort
```

### Session-aware reads — `--main`

Read commands (`read`, `section`, `outline`, `files`, `grep`, `get`, `app`)
read from the active session worktree by default.  Use `--main` to force a
read from the main branch:

```bash
kb read maestro           # reads session worktree (if session active)
kb read maestro --main    # always reads main branch
```

---

## `kb status`

Top-level vault overview: active session, dirty (uncommitted) files, last
commit.

```bash
kb status
```

---

## `kb log`

Knowledge audit history with frontmatter field-change tracking. Shows which
fields changed, old and new values, per commit.

```
kb log [NAME] [--dir tools|research|docs] [--field FIELD] [--since DATE] [--json]
```

```bash
kb log maestro                           # full history for maestro
kb log maestro --field type              # only commits that changed 'type'
kb log --dir research --since 2025-01-01 # research history since date
kb log maestro --json                    # structured [{sha, date, message, field_changes, file_changes}]
```


## Configuration

```bash
# Override the default vault path
export KB_ROOT=/path/to/dp-knowledge-base
```

## When to Use `kb`

| Task | Command |
|------|---------|
| Enumerate all tools | `kb list` |
| Find tools by category or team | `kb search category=<x>` |
| Find tools by org (alias) | `kb search apex` |
| Fuzzy/regex field filter | `kb search type~oss` / `kb search team:Orchestration` |
| Check tool identity, ownership, status | `kb app <name>` |
| Check if a specific tool is tracked | `kb read <name>` |
| Discover sections in an entry | `kb outline <name>` |
| Read one section | `kb section <name> <heading>` |
| List all docs in an entry directory | `kb files <name>` |
| Get a single field value | `kb get <name> <field>` |
| See value distribution for a field | `kb values <field>` |
| Search entry bodies for text | `kb grep <pattern>` |
| Inspect schema definition | `kb schema` |
| List search aliases | `kb aliases` |
| Audit which tools lack a field | `kb missing <field>` |
| View security hardening posture for a service | `kb readiness <name>` |
| Fleet security posture table | `kb readiness` |
| Filter readiness by ring | `kb readiness --ring N` |
| Get structured data for downstream processing | `kb list --json` |
| Start an isolated multi-change session | `kb session start --name <label>` |
| List active sessions | `kb session list` |
| Commit session changes to main | `kb session commit "message"` |
| Vault overview (session, dirty files, last commit) | `kb status` |
| Audit field-change history for an entry | `kb log <name>` |
| Filter history to one field | `kb log <name> --field <field>` |

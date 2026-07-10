---
name: kb
description: >
  Query and navigate the dp-knowledge-base using the `kb` CLI. Covers listing,
  filtering (exact/substring/regex), reading entries, outline/section navigation,
  single-field lookup, app profiles, schema/value inspection, security readiness
  grids (`kb readiness`), structured assessments (`kb assess`), concept explanations
  (`kb explain`), and docs browsing (`kb doc`). Also scaffolds new entries
  with SPEC-live frontmatter (`kb new`) and opens entries in $EDITOR
  (`kb edit`). Supports alias CRUD (`kb alias`), spinnaker_app_name fallback
  resolution, brainstorm subdirectories, brainstorm-to-research promotion
  (`kb brainstorm promote`), and cross-file header outlines (`kb summary`).
  Prefer `kb` over reading vault files directly.
  Requires: ripgrep for `kb grep`, fzf for interactive selection.
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

`kb` is a personal CLI for querying and maintaining the dp-knowledge-base vault.
It reads YAML frontmatter (and a header-convention fallback for `docs/`) from
Markdown files and lets you list, filter, read, audit, navigate, scaffold
(`kb new`), and edit (`kb edit`) entries. Set `KB_ROOT` to override the default
vault path (`/Users/charsmith/Documents/the_vault/dp-knowledge-base`).

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

# ── Scaffold / edit ───────────────────────────────────────────────────────────
kb new tool myservice                # tools/myservice/overview.md, SPEC-live frontmatter
kb new research some-topic           # research/some-topic/some-topic.md
kb new doc --template-only           # print docs/SPEC.md's blank frontmatter block
kb new tool myservice --open         # create, then open in $EDITOR
kb new tool myservice --force        # overwrite existing entry
kb edit ablaze                       # open tools/ablaze/overview.md in $EDITOR
kb edit ablaze --file security       # open tools/ablaze/security.md

# ── Security readiness ──────────────────────────────────────────────────────
kb readiness                         # fleet view: all tools with security.md
kb readiness maestro                 # single service panel
kb readiness --ring 0                # Ring 0 tools only
kb readiness apex                    # filter by alias
kb readiness --json                  # machine-readable

# ── Open in Obsidian (macOS only) ────────────────────────────────────────────
kb doc blast-radius-guide --open     # open vault file; prints nothing
kb read spinnaker --plain --open     # print, then open
kb app maestro --open                # open tool's overview.md
kb readiness maestro --open          # open security.md (single service only)
kb explain l1 --open                 # open source doc

# ── Brainstorm ───────────────────────────────────────────────────────────────────────
kb brainstorm promote deep-dive          # copy brainstorm → research/, write lineage frontmatter
kb brainstorm promote deep-dive --dry-run
kb brainstorm promote quick-idea --json  # {source, dest, kind, files_copied, status, message}

# ── Summary ────────────────────────────────────────────────────────────────────────────
kb summary project-x --dir brainstorm    # H1/H2 outline across all .md files in subdir
kb summary project-x --dir brainstorm --json  # [{"file": "...", "headers": [...]}]

# ── Alias CRUD ──────────────────────────────────────────────────────────────────────
kb alias list                            # rich table of all aliases
kb alias list --kind org                 # filter by kind: org|filter|entry
kb alias list --json
kb alias show infra                      # full detail: expansion, kind, desc
kb alias add myalias 'language=java'     # add filter alias
kb alias add infra 'dp_org_owner:infra' --kind org --desc 'Infra team'
kb alias add infra 'new-expansion' --force
kb alias rm myalias                      # remove alias
kb alias rm myalias --dry-run
kb alias edit java --desc 'Java microservices'
kb alias edit java --expansion 'language=kotlin'

# ── Clone / pull repos ───────────────────────────────────────────────────────
kb clone myservice               # clone repo: URL → KB_REPOS_ROOT/<slug>, patch cloned:
kb clone --all                   # clone all tools with repo: but no cloned:
kb clone --all --dry-run         # preview what would be cloned
kb pull myservice                # git pull in the cloned directory
kb pull --all                    # pull all cloned tools

# ── pt integration ───────────────────────────────────────────────────────────
kb pt maestro posture                # thin passthrough to `pt app <spin> posture`
kb report maestro --refresh          # regenerate cached pt report, then display
kb report maestro                    # view cached report (or "No report cached")
kb report maestro --verbose          # expand collapsed pass findings
kb report maestro --plain            # tab-separated output, no ANSI (pipeable)

# ── Sessions ─────────────────────────────────────────────────────────────────
export KB_SESSION=$(kb session start --name mywork)  # start session, capture branch
kb session list                      # list open sessions (branch, changes, age)
kb session status                    # KB-semantic view of changed entries
kb session diff                      # full diff vs main for active session
kb session diff mywork               # diff for named session
kb session commit "batch update"     # merge to main + clean up worktree + branch
kb session abort                     # discard session without merging

# ── Vault status / history ───────────────────────────────────────────────────
kb status                            # active session + dirty files + last commit
kb log maestro                       # full commit history for an entry
kb log maestro --field type          # only commits that changed 'type'
kb log --dir research --since 2025-01-01 --json

# ── Security assessments ─────────────────────────────────────────────────────
kb assess maestro l1 pass "Deploy pipeline has canary + rollback gate"
kb assess maestro icfd compliant "ICFD review passed 2025-06-01" --dry-run
kb assess maestro l4 warning "Rate-limit present but no per-user cap" --json
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
| `brainstorm` | path + all frontmatter keys present + `file_count` (flat `.md` files **and** named subdirectories — same primary-file precedence as research: `overview.md` → `<dirname>.md` → first alphabetically); supports frontmatter filtering with `=`, `~`, `:` operators |

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
kb search status=active --dir brainstorm   # brainstorm frontmatter filtering
```

---

### `kb brainstorm promote`

```
kb brainstorm promote <name> [--dry-run] [--json]
```

Copies a brainstorm entry (flat `.md` file **or** subdirectory) to `research/`, writing
bidirectional lineage frontmatter in both directions. **Non-destructive** — the source
brainstorm entry is never deleted. Session-aware: writes to the active session’s worktree
when one is active.

**Frontmatter written:**

| File | Field added |
|------|-------------|
| Destination (`research/<name>`) primary file | `promoted_from: brainstorm/<name>` |
| Source (`brainstorm/<name>`) primary file | `promoted_to: research/<name>` |

Primary file selection order inside a directory: `overview.md` → `<name>.md` → first
alphabetically.

**`--json` shape (`PromoteResult`):**
```json
{
  "source": "brainstorm/deep-dive",
  "dest": "research/deep-dive",
  "kind": "dir",
  "files_copied": 3,
  "status": "promoted",
  "message": "Promoted brainstorm/deep-dive → research/deep-dive (3 file(s) copied)."
}
```

**`status` values:** `"promoted"` · `"dry_run"` · `"not_found"`  
**`kind` values:** `"dir"` (subdir entry) · `"flat"` (single `.md` file)

```bash
kb brainstorm promote deep-dive            # promote subdir entry
kb brainstorm promote quick-idea           # promote flat .md file
kb brainstorm promote deep-dive --dry-run  # preview without writing
kb brainstorm promote quick-idea --json    # structured output
```

---

### `kb summary`

```
kb summary <name> [--dir brainstorm] [--json] [--plain]
```

Displays an H1/H2 header outline concatenated across **all** `.md` files in a brainstorm
subdirectory, prefixed by filename. For a flat file entry, equivalent to `kb outline`.
Only `--dir brainstorm` is currently implemented; other directories exit 1.

Default output is a Rich table (file → headers). `--plain` gives tab-separated
`file\theader` pairs (pipeable). `--json` returns a list of objects.

**`--json` shape:**
```json
[
  {"file": "overview.md", "headers": ["# Overview", "## Background", "## Goals"]},
  {"file": "notes.md",    "headers": ["# Notes", "## Open Questions"]}
]
```

```bash
kb summary project-x --dir brainstorm            # rich table
kb summary project-x --dir brainstorm --json     # [{"file": ..., "headers": [...]}]
kb summary project-x --dir brainstorm --plain    # file\theader (pipeable)
```

---

### `kb alias`

Full CRUD for named aliases stored in `kb.yaml`. Distinct from the read-only
`kb aliases` command (which just lists them). Changes are written to `kb.yaml` immediately.

#### `kb alias list`

```
kb alias list [--kind org|filter|entry] [--json]
```

Rich table of all aliases. `--kind` narrows to one category. `--json` returns a list of
alias objects.

```bash
kb alias list
kb alias list --kind org
kb alias list --kind filter --json
```

#### `kb alias show`

```
kb alias show <name> [--json]
```

Full detail for a single alias: expansion string, kind, description. Exits 1 if the alias
doesn’t exist.

```bash
kb alias show infra
kb alias show apex --json
```

#### `kb alias add`

```
kb alias add <name> <expansion> [--kind filter] [--desc "..."] [--force] [--json]
```

Adds a new alias to `kb.yaml`. `<expansion>` is a filter expression
(e.g. `language=java` or `dp_org_owner:"Analytics Platform"`). `--force` overwrites an
existing alias with the same name. Exits 1 if the alias already exists and `--force` is
not given.

| Option | Default | Description |
|--------|---------|-------------|
| `--kind` | `filter` | Alias kind: `org`, `filter`, `entry` |
| `--desc` | `` | Human-readable description |
| `--force` | false | Overwrite existing alias |
| `--json` | false | Emit the created `AliasEntry` as JSON |

**`--json` shape:**
```json
{"name": "myalias", "expansion": "language=java", "kind": "filter", "desc": "Java services"}
```

```bash
kb alias add myalias 'language=java'
kb alias add infra 'dp_org_owner:infra-team' --kind org --desc 'Infra team'
kb alias add infra 'new-expansion' --force   # overwrite existing
kb alias add myalias 'language=java' --json
```

#### `kb alias rm`

```
kb alias rm <name> [--dry-run] [--json]
```

Removes an alias from `kb.yaml`. Exits 1 if the alias doesn’t exist.
`--dry-run` shows what would be removed without writing. `--json` returns
`{"message": "..."}` on success.

```bash
kb alias rm myalias
kb alias rm myalias --dry-run
kb alias rm myalias --json
```

#### `kb alias edit`

```
kb alias edit <name> [--expansion <str>] [--kind <str>] [--desc <str>] [--json]
```

Edits one or more fields of an existing alias in-place. Only supplied options are changed;
unspecified fields remain unchanged. Exits 1 if the alias doesn’t exist.

```bash
kb alias edit java --desc 'Java microservices'
kb alias edit java --expansion 'language=kotlin'
kb alias edit java --kind entry
kb alias edit java --expansion 'language=groovy' --desc 'Groovy too' --json
```

---

### `kb app`

```
kb app [NAME] [--json] [--plain] [--open]
```

Displays a structured profile for a tool entry in three panels. Only searches
the `tools` directory. When `NAME` is omitted, launches **fzf** for interactive
selection (requires `brew install fzf`).
`--open` opens the tool's `overview.md` in Obsidian (macOS only).

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
kb read <name> [--dir tools|research|docs] [--json] [--plain] [--open]
```

Prints frontmatter as YAML followed by up to 60 lines of the entry body.
`<name>` is the directory name (tools/research) or filename stem (docs).
Exits non-zero if the entry is not found. When `NAME` is omitted, launches
**fzf** for interactive selection (requires `brew install fzf`).
`--open` opens the vault file in Obsidian (macOS only).

```bash
kb read spinnaker
kb read maestro --dir research
kb read spinnaker --open            # open in Obsidian (prints nothing)
kb read spinnaker --plain --open    # print, then open
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
kb section <name> <header> [--dir tools|research|docs] [--json] [--open]
```

Prints the body of the first section whose heading contains `<header>` as a
substring (case-insensitive). The section runs from the matched heading to the
next heading at the same or higher level.
`--open` opens the vault file in Obsidian (macOS only).

```bash
kb section maestro "Auth"        # section whose heading contains "Auth"
kb section maestro overview --json
kb section maestro "Auth" --open # open vault file in Obsidian
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
| `bdo` | `team~"BDO"` |
| `ddx` | `team~"DDX"` |
| `engines` | `team~"Engines"` |
| `lakehouse` | `team~"Lakehouse"` |

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

### `kb new`

```
kb new <kind> [<name>] [--template-only] [--open] [--force] [--json]
```

Scaffolds a new SPEC-compliant entry. `<kind>` is one of `tool`, `research`,
`doc`, `brainstorm`. Frontmatter is generated **live** from the target kind's
`SPEC.md` `## Frontmatter Schema` block — there is no hardcoded schema in
Python, so it always reflects the current SPEC. Session-aware: writes to the
active session's worktree when one is active (commit deferred to
`kb session commit`); otherwise writes directly to the vault and auto-commits.

**Target paths per kind:**

| Kind | Target path | Frontmatter | Body |
|------|-------------|--------------|------|
| `tool` | `tools/<name>/overview.md` | live from `tools/SPEC.md` | one-line description placeholder |
| `research` | `research/<name>/<name>.md` | live from `research/SPEC.md` | `## Question` / `## Findings` / `## See Also` |
| `doc` | `docs/<name>.md` | live from `docs/SPEC.md` | headers from `docs/SPEC.md`'s `## Body Format` block |
| `brainstorm` | `brainstorm/<name>.md` | **none** — brainstorm has no `SPEC.md` | minimal `# <name>` |

`--template-only` prints the blank frontmatter block to stdout and writes
nothing (`<name>` is optional in this mode — useful to see the current
schema). `<name>` is required otherwise. `kb new` exits 1 if the target already exists (unless `--force` is given), or if `<name>` is missing without `--template-only`.

```bash
kb new tool myservice                    # tools/myservice/overview.md
kb new research some-topic               # research/some-topic/some-topic.md
kb new doc onboarding-v2                 # docs/onboarding-v2.md
kb new brainstorm pipeline-idea          # brainstorm/pipeline-idea.md, no frontmatter

kb new doc --template-only               # print docs/SPEC.md's blank frontmatter block
kb new tool myservice --json             # {"kind","name","path","created":true}

kb new tool myservice --open             # create, then open in $EDITOR
kb new tool myservice --force            # overwrite if already exists

# Inside a session — deferred commit
export KB_SESSION=$(kb session start scaffold-work)
kb new tool myservice
kb session commit "add myservice scaffold"
```

---

### `kb edit`

```
kb edit <name> [--file STEM] [--dir tools|research|docs|brainstorm]
```

Opens a resolved knowledge-base entry in `$EDITOR` (falls back to `vi` when
unset). Resolution mirrors `kb read`/`kb patch --file`: fuzzy name matching
(exact → prefix → contains), the `spinnaker_app_name` fallback, `--dir`
(default `tools`), and `--file STEM` to target a specific `.md` file inside a
tool/brainstorm directory instead of the default `overview.md`. Session-aware:
edits the active session's worktree when one is active (commit deferred to
`kb session commit`); otherwise commits directly to the vault — **only if the
file's bytes actually changed** (a no-op edit is never committed).

`kb edit` never creates files: if `<name>` (or `--file`) doesn't resolve to an
existing entry, it exits 1 with a message suggesting the matching `kb new`
invocation.

```bash
kb edit ablaze                           # edit tools/ablaze/overview.md
kb edit ablaze --file security           # edit tools/ablaze/security.md
kb edit onboarding --dir docs            # edit docs/onboarding.md
kb edit some-topic --dir research        # edit research/some-topic/some-topic.md
kb edit maestro-app-name                  # resolves via spinnaker_app_name fallback

kb edit missing-thing                    # exits 1, suggests `kb new tool missing-thing`
```

---


---

### `kb clone`

```
kb clone [<name>] [--all] [--dir tools|research|docs] [--dry-run] [--json]
```

Clone the git repo recorded in a tool's `repo:` frontmatter field to
`$KB_REPOS_ROOT/<slug>` (default `~/code/knowledge_base_repos`). After a
successful clone, patches the entry's `cloned:` field with the local path and
auto-commits (or defers to `kb session commit` when a session is active).

Override the base directory with `KB_REPOS_ROOT`:
```bash
export KB_REPOS_ROOT=~/code/nflx
```

| Option | Description |
|--------|-------------|
| `<name>` | Entry name (fuzzy matched) |
| `--all` | Clone all eligible entries that have `repo:` set but `cloned:` unset |
| `--dir` | Vault sub-directory to scan (default `tools`) |
| `--dry-run` | Show what would be cloned; writes nothing |
| `--json` | `[{"name", "repo", "dest", "status", "message"}]` |

**`status` values:** `"cloned"` · `"skipped"` (directory already exists) · `"error"` · `"dry-run"`

```bash
kb clone myservice               # clone single entry
kb clone --all                   # bulk clone (skips already-cloned)
kb clone --all --dry-run         # preview
kb clone myservice --json
kb clone --all --json
```

---

### `kb pull`

```
kb pull [<name>] [--all] [--dir tools|research|docs] [--json]
```

Run `git pull` in the directory recorded in a tool's `cloned:` frontmatter.

| Option | Description |
|--------|-------------|
| `<name>` | Entry name (fuzzy matched; must have `cloned:` set) |
| `--all` | Pull every entry that has `cloned:` set |
| `--dir` | Vault sub-directory to scan (default `tools`) |
| `--json` | `[{"name", "path", "status", "summary"}]` |

**`status` values:** `"updated"` · `"up-to-date"` · `"error"`

```bash
kb pull myservice
kb pull --all
kb pull myservice --json
kb pull --all --json
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
| **pt** | `kb pt`, `kb report --refresh` | `uv tool install --editable <pt-repo>` |

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
| Record a security assessment | `kb assess <name> <field> <value> "<evidence>"` |
| Preview an assessment without writing | `kb assess ... --dry-run` |
| Drill into one readiness field (evidence+date) | `kb readiness --level <field>` |
| Look up a security concept or tool summary | `kb explain <concept>` or `kb explain <tool-name>` |
| Browse or extract from a docs entry | `kb doc <name> [--front\|--url\|--outline\|--section\|--summary]` |
| Open a vault file in Obsidian (macOS only) | `kb doc/read/app/section/explain/readiness <name> --open` |
| Patch a non-overview file in a tool dir | `kb patch <name> <field>=<value> --file <stem>` |
| Scaffold a new entry (SPEC-live frontmatter) | `kb new <kind> <name>` |
| Scaffold and open in \$EDITOR | `kb new <kind> <name> --open` |
| Overwrite an existing scaffold | `kb new <kind> <name> --force` |
| Clone a tool's repo | `kb clone <name>` |
| Bulk clone all tools | `kb clone --all` |
| Pull updates in a cloned tool's repo | `kb pull <name>` |
| Bulk pull all cloned tools | `kb pull --all` |
| Preview a kind's blank frontmatter schema | `kb new <kind> --template-only` |
| Open an entry in $EDITOR | `kb edit <name>` |
| Edit a non-overview file in a tool dir | `kb edit <name> --file <stem>` |
| Promote brainstorm entry to research | `kb brainstorm promote <name>` |
| Preview a brainstorm promote | `kb brainstorm promote <name> --dry-run` |
| H1/H2 outline across all files in a brainstorm subdir | `kb summary <name> --dir brainstorm` |
| List / filter aliases in kb.yaml | `kb alias list [--kind org\|filter\|entry]` |
| Show full alias detail | `kb alias show <name>` |
| Add a new alias | `kb alias add <name> <expansion> [--kind filter]` |
| Remove an alias | `kb alias rm <name>` |
| Edit an alias in-place | `kb alias edit <name> [--expansion ...] [--desc ...]` |

---

## Layer 6 — Assessment Layer

### `kb patch --file <stem>`

```
kb patch <name> <field>=<value> [--dir tools|research|docs] [--file STEM] [--dry-run] [--json]
```

`--file STEM` targets a specific `.md` file inside a tool directory instead of
the default `overview.md`. All other patch semantics are unchanged.

```bash
kb patch maestro l1=pass --file security       # patches security.md in the maestro dir
kb patch maestro icfd=compliant --file security
kb patch maestro l1=pass --file security --dry-run
```

---

### Name resolution: `spinnaker_app_name` fallback

All name-matching commands (`read`, `app`, `get`, `patch`, `assess`, etc.)
first try to match the vault directory name (exact → prefix → contains), then
fall back to matching the `spinnaker_app_name` frontmatter field using the same
priority order. This lets you reference tools by their Spinnaker app name when
it differs from the directory name.

---

### `kb assess`

Record a structured security assessment into a tool's `security.md` frontmatter.
Validates field name and value. Auto-commits when no session is active.

```
kb assess <name> <field> <value> "<evidence>" [--dry-run] [--json]
```

**Assessable fields:**

| Field | Allowed values |
|-------|---------------|
| `l1`–`l6` | `pass`, `warning`, `critical`, `fail`, `unassessed` |
| `icfd` | `compliant`, `non-compliant`, `unassessed` |
| `wfs_registered` | `true`, `false` |
| `scrub_app_ingress` | `true`, `false` |

```bash
kb assess maestro l1 pass "Deploy pipeline has canary + rollback gate"
kb assess maestro l3 critical "No per-query auth"
kb assess maestro icfd compliant "ICFD review passed 2025-06-01" --dry-run
kb assess maestro l4 warning "Rate-limit present but no per-user cap" --json
```

`--json` shape: `{"entry", "field", "old_value", "new_value", "assessed_at"}`

**Agent rule:** if your task requires more than one `kb assess` call, start a
session first to avoid partial commits landing on `main`.

---

### `kb readiness --level <field>`

The `--level` flag drills into a single assessed field across all (or filtered)
services, showing value, evidence text, and assessed date.

```bash
kb readiness --level l1           # fleet view: L1 value + evidence + date
kb readiness --level icfd         # ICFD status across the fleet
kb readiness maestro --level l3   # single service, L3 details
kb readiness --ring 0 --level l4  # Ring 0 only, L4 details
```

Accepted `--level` values: `l1` `l2` `l3` `l4` `l5` `l6` `icfd`
`wfs_registered` `scrub_app_ingress`

---

### `kb explain`

Look up a security concept **or** get a quick summary of any tool entry.
Prefer `kb explain <tool-name>` when you need a fast one-liner on what a tool
does and who owns it — no need to run `kb app` for a full profile.

Resolution is two-step:

1. **Concept match** — looks up `<concept>` in `concept_docs` of
   `tools/security-SPEC.md` (case-insensitive, prefix matching) and renders the
   referenced doc/section.
2. **Tool entry fallback** — if no concept matches, resolves `<concept>` as a
   tool name (fuzzy + `spinnaker_app_name` fallback) and renders a compact blurb:
   `type`, `team`, `owning_org`, `spinnaker_app_name`, and the first body paragraph.
3. **Nothing found** → exits 1:
   `Unknown concept or tool '<concept>'. Known concepts: …. Try kb app <name> for a full profile.`

```
kb explain <concept> [--json] [--plain] [--open]
```

`--plain` prints raw Markdown (concept) or tab-separated `name\ttype\tteam\tsummary` (tool).
`--open` opens the source doc (concept) or `overview.md` (tool) in Obsidian (macOS only).

**`--json` shape — concept match:**
```json
{"concept": "icfd", "doc": "...", "section": "...", "body": "..."}
```

**`--json` shape — tool match:**
```json
{"kind": "tool", "name": "metacat", "type": "service", "team": "...", "owning_org": "...", "spinnaker_app_name": "metacat", "summary": "..."}
```

```bash
kb explain l1              # concept doc — renders L1 section
kb explain icfd            # concept doc — ICFD compliance requirement
kb explain metacat         # tool fallback — compact blurb for the metacat tool
kb explain icfd --json     # {"concept": "icfd", "doc": "...", "section": "...", "body": "..."}
kb explain metacat --json  # {"kind": "tool", "name": "metacat", ...}
kb explain l1 --plain      # raw Markdown (pipeable)
kb explain metacat --plain # name\ttype\tteam\tsummary (tab-separated)
kb explain l1 --open       # open source doc in Obsidian
kb explain metacat --open  # open tools/metacat/overview.md in Obsidian
```

Each `concept_docs` entry may include an optional `dir` key (default: `docs`) to resolve against a different vault directory — e.g. `dir: research` resolves against `research/<doc>/<doc>.md`.

---

### `kb doc`

Fuzzy lookup of a `docs/` entry with optional views. Default renders the full
document as Rich Markdown.

```
kb doc <name> [--front] [--text] [--url] [--outline] [--section <header>] [--summary]
             [--json] [--plain] [--open] [--opendoc]
```

View flags are mutually exclusive (only one may be given at a time).

| Flag | Effect |
|------|--------|
| `--front` | Print frontmatter YAML |
| `--text` | Fetch the full document text from its external `source:` URL via `ns`; requires `ns` on `PATH` and a `source:` URL in frontmatter |
| `--url` | Print the `source` URL (pipeable) |
| `--outline` | Print the heading tree |
| `--section <header>` | Print the first section matching `<header>` (case-insensitive substring) |
| `--summary` | Extractive summary — first sentence per section |
| `--json` | Machine-readable (format varies by flag) |
| `--plain` | Raw Markdown output instead of Rich-rendered |
| `--open` | Open the vault `.md` file in Obsidian (macOS only); combine with display flags to print first, then open |
| `--opendoc` | Open the doc's `source:` URL in your default browser (macOS only; distinct from `--open` which opens the vault file in Obsidian) |

```bash
kb doc control-plane-hardening
kb doc blast-radius-guide --url
kb doc blast-radius-guide --front
kb doc blast-radius-guide --outline
kb doc blast-radius-guide --section "L2 Operator"
kb doc blast-radius-guide --section "L2 Operator" --json
kb doc control-plane-hardening --summary
kb doc control-plane-hardening --plain      # raw Markdown (pipeable)
kb doc blast-radius-guide --text            # fetch full text via ns from source URL
kb doc blast-radius-guide --text --json     # {"text": "..."}
kb doc blast-radius-guide --open            # open vault .md in Obsidian (prints nothing)
kb doc blast-radius-guide --front --open    # print frontmatter, then open in Obsidian
kb doc blast-radius-guide --opendoc        # open source URL in default browser
```

---

## Layer 7 — pt Integration

Wraps the `pt` security-audit CLI: a thin passthrough (`kb pt`) plus a cached,
human-readable report (`kb report`) stored at `tools/<name>/report.md`.
Requires `pt` on `PATH` — both commands exit 1 with an install hint when it's
missing:

```
kb pt requires pt — install with: uv tool install --editable <pt-repo>
kb report --refresh requires pt — install with: uv tool install --editable <pt-repo>
```

### `kb pt`

Resolves `<name>` to `spinnaker_app_name` (same fuzzy matching + fallback as
every other command) and execs `pt app <spinnaker-app-name> <subcommand>
[args...]`, inheriting stdio and exit code — no output capture, no parsing.
Unknown flags (`--json`, `--auth`, ...) pass straight through to `pt`.

```
kb pt <name> <subcommand> [args...]
```

```bash
kb pt maestro posture
kb pt databridge posture
kb pt maestro config --auth --json
kb pt maestro icfd
```

Missing `spinnaker_app_name` on the resolved entry exits 1 with:

```
No spinnaker_app_name for <name> — run kb patch <name> spinnaker_app_name=<value> to set it
```

### `kb report`

Cached `pt` audit report at `tools/<name>/report.md`.  Five reader-question
sections: **Identity & Ownership**, **Security Posture**, **Stability**,
**Operational Health**, **Platform Compliance**.

**Console UX.** Renders a compact Rich terminal view — not a raw Markdown blob:

- **Verdict panel** — colour-coded border (green ok / yellow warn / red fail),
  roll-up status, and up to 3 top gaps.
- **Identity strip** — one dim line under the panel.
- **Section separators** with inline gap count: `── Security ──── 2 gap(s) ──`
- **Per-finding colour** — `✗` red for fail/critical, `!` yellow for warn,
  `✓` dim green for pass, `•` for info. Fixed 4-symbol vocab, no emoji.
- **Pass collapse** — passes folded to `N check(s) passed` by default;
  `--verbose` expands them.

**Schema auto-refresh.** Stale v1 caches (predating the Stability renderer)
auto-refresh when `pt` is available instead of silently dropping sections.

```
kb report <name> [--refresh] [--verbose] [--plain] [--wfs-full] [--age] [--open] [--json]
```

| Option | Effect |
|--------|--------|
| `--refresh` | Run `pt` fresh for all sections (`posture`, `icfd`, `wfs`, `config --auth`, `alerts`), atomically rewrite report.md, auto-commit |
| `--verbose`, `-v` | Expand collapsed pass findings; default folds passes to one dim summary line per section |
| `--plain` | No ANSI/Rich markup — emit `status\tlabel\tdetail` tab-separated rows (pipe-friendly) |
| `--wfs-full` | Show all 29 unpacked WFS categories; default collapses `MANAGEMENT_LEVEL_UNSPECIFIED` rows to a count line |
| `--age` | Print only the cached age, e.g. `3h 14m ago` |
| `--open` | Open report.md in Obsidian (macOS only) |
| `--json` | Emit frontmatter + `verdict` ("ok"\|"warn"\|"fail") + `sections: [{title, status}]` as JSON; `{}` if no report cached |

**Staleness:**
- No cached report → `No report cached — run kb report <name> --refresh`, exit 0.
- Fresh (< 24h) → renders report + dim `generated N ago` footer.
- Stale (≥ 24h) → renders report + yellow `Report is Nh old — run kb report <name> --refresh` warning.

**Security Posture** signal differentiation:
- CISA KEV CVE present → blockquote callout immediately after verdict.
- `exploitable_cve_cnt > 0` → ✗ N exploitable CVE(s) bullet.
- `uses_service_mesh=False` → ✗ bullet naming the missing controls (no circuit breaking, no mTLS via proxy).

**Stability** (inserted between Security Posture and Operational Health) draws from three signals:
- Alert events from `pt app <spin> alerts --json` — state-aware: ✗ if any alert is currently firing (`state: "alerting"`); ! if any recovered within the last 24 h; • info if all recovered >24 h ago; ✓ pass if no events.
- ICFD `dep_update_health.pass_rate` — ✗ < 50 %, ! 50–79 %, ✓ ≥ 80 %.
- ICFD `confidence.away_team` — ! if SOMEWHAT_DISAGREE or DISAGREE.

**Reliability alert signal** (used in the console `Reliability` section, distinct from the report.md Stability section above):
- `✗` **fail** — any alert with `state: "alerting"` (currently firing)
- `!` **warn** — recovered within 24 h (`state: "ok"`)
- `•` **info** — all alerts resolved >24 h ago; label: `N alert events — all resolved`
- `✓` **pass** — no alert events

`--verbose` / `-v` adds per-active-alert findings (name, group, `triggered Xm ago`) plus top-3 recovered types (`N × Alert_Name  all resolved`) and most recent recovery age. The lead alert finding carries a dim drill-down hint: `kb pt <name> alerts`.

**Platform Compliance (WFS)** unpacks the `MANAGEMENT_LEVELS` container into a
`| Category | Status | Note |` table summarised as `N of 29 categories platform-managed`.
Default view collapses unspecified rows; `--wfs-full` expands all 29.

```bash
kb report maestro                     # view cached report (or "No report cached")
kb report maestro --refresh           # regenerate from a live pt run, then display
kb report maestro --verbose           # expand collapsed pass findings
kb report maestro --plain             # tab-separated, no ANSI (pipeable)
kb report maestro --refresh --wfs-full  # expand all 29 WFS categories
kb report maestro --age               # just the age
kb report maestro --open              # open report.md in Obsidian
kb report maestro --json              # verdict + section roll-up as JSON
```

`kb app`'s Status panel shows `Last report: N ago (kb report <name>
--refresh)` whenever a report.md is cached for that tool.

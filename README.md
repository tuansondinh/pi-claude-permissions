# pi-claude-permissions

Claude-style allow/deny/ask lists for Pi tool calls.

Standalone repo. Runtime gate only. Built to coexist with `pi-lazy-tools`.

Design tuned after studying `claw-code` permission flow:
- `deny` wins over `ask`, `ask` wins over `allow`
- session rules override project rules override global rules
- `ask` falls back to block in non-interactive mode

Built to work with `pi-lazy-tools`:
- does **not** touch `setActiveTools`
- does **not** replace `tool_search`
- does not include `tool_search` defaults because it belongs to user-installed tool-search extensions

## Install

```bash
pi install /absolute/path/to/pi-claude-permissions
```

Or load without installing:

```bash
pi -e /absolute/path/to/pi-claude-permissions/extensions/index.ts
```

## Behavior

- intercepts `tool_call`
- evaluates rules in this order:
  1. session rules
  2. project config: `.pi/tool-permissions.json`
  3. global config: `~/.pi/agent/tool-permissions.json`
  4. fallback `defaultAction`
- source precedence: project overrides global
- action precedence inside each source: `deny` → `ask` → `allow`
- no extension-specific built-in allow rules
- default fallback: `allow`

## Rule format

Each rule is string pattern:

- `tool_name` → match all calls for tool
- `tool_name:target-pattern` → match tool + target
- `*` → match any tool
- `*:target-pattern` → match any tool with target

Wildcard `*` supported.

### Targets by tool

- `bash` → command string
  - for matching, extension also normalizes known RTK rewrites like `RTK_DB_PATH=... rtk git push` back to `git push`
  - user `!` / `!!` bash commands are not affected; extension only gates agent tool calls
- `read` / `write` / `edit` → `path`
- `mcp` → tool name if `input.tool` exists, else forms like `connect:github`, `search:foo`, `describe:bar`
- other tools → compact JSON of input

## Example config

Project file: `.pi/tool-permissions.json`

Global file: `$(getAgentDir)/tool-permissions.json` in Pi terms, usually `~/.pi/agent/tool-permissions.json`

```json
{
  "defaultAction": "allow",
  "allow": [
    "read:*",
    "ls",
    "grep",
    "find",
    "bash:git status*",
    "bash:git diff*"
  ],
  "ask": [
    "write:*",
    "edit:*",
    "bash:*",
    "mcp:*"
  ],
  "deny": [
    "bash:rm -rf*",
    "bash:sudo *",
    "write:.env*",
    "edit:.env*"
  ]
}
```

## Interactive choices

When rule says `ask`, extension prompts with:

- Allow once
- Allow for session
- Allow for project
- Allow globally
- Deny for session
- Deny for project
- Deny globally
- Cancel

Session decisions live only in memory. Project/global decisions append rule to config file.

## Commands

- `/permissions` — show active config summary + paths
- `/permissions:on` — enable permission checks for current session
- `/permissions:off` — disable permission checks for current session
- `/permissions:ask` — set fallback mode to ask for current session
- `/permissions:allow` — set fallback mode to allow for current session
- `/permissions:deny` — set fallback mode to deny for current session
- `/permissions:init` — create starter project config at `.pi/tool-permissions.json`
- `/permissions:init force` — overwrite project config with starter config
- `/permissions:help` — show rule help and config example

Argument-style aliases also work: `/permissions on`, `/permissions off`, `/permissions mode ask`, `/permissions init`, `/permissions help`.

## Footer status

Extension writes footer status via `ctx.ui.setStatus("claude-permissions", ...)`:

- `permissions:on` — checks enabled
- `permissions:off` — checks disabled for current session

## Notes

- In non-interactive mode, `ask` becomes block.
- File rules match both raw path and resolved absolute path.
- Bash rules match normalized command candidates so common wrappers like RTK git rewrites still hit intended rules.
- This extension only gates agent tool calls, not user `!` / `!!` shell commands.
- Default behavior is broad allow with targeted prompts: `defaultAction: "allow"` plus `ask` / `deny` lists.
- If you want stricter Claude-like behavior, set `defaultAction: "ask"` and grow `allow` / `deny` over time.

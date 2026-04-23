# pi-claude-permissions

Claude-style allow/deny/ask lists for Pi tool calls.

Standalone repo. Runtime gate only. Built to coexist with `pi-lazy-tools`.

Design tuned after studying `claw-code` permission flow:
- `deny` wins over `ask`, `ask` wins over `allow`
- session rules override project rules override global rules
- `tool_search` always allowed for `pi-lazy-tools` compatibility
- `ask` falls back to block in non-interactive mode

Built to work with `pi-lazy-tools`:
- does **not** touch `setActiveTools`
- does **not** replace `tool_search`
- allows `tool_search` by default so agent can unlock tools

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
- default built-in allow: `tool_search`
- default fallback: `ask`

## Rule format

Each rule is string pattern:

- `tool_name` → match all calls for tool
- `tool_name:target-pattern` → match tool + target
- `*` → match any tool
- `*:target-pattern` → match any tool with target

Wildcard `*` supported.

### Targets by tool

- `bash` → command string
- `read` / `write` / `edit` → `path`
- `mcp` → tool name if `input.tool` exists, else forms like `connect:github`, `search:foo`, `describe:bar`
- other tools → compact JSON of input

## Example config

Project file: `.pi/tool-permissions.json`

Global file: `$(getAgentDir)/tool-permissions.json` in Pi terms, usually `~/.pi/agent/tool-permissions.json`

```json
{
  "defaultAction": "ask",
  "allow": [
    "tool_search",
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
- `/permissions clear-session` — clear in-memory session rules
- `/permissions help` — show rule help
- `/permissions allow <session|project|global> <rule>` — add allow rule
- `/permissions ask <session|project|global> <rule>` — add ask rule
- `/permissions deny <session|project|global> <rule>` — add deny rule
- `/permissions remove <allow|ask|deny> <session|project|global> <rule>` — remove rule

## Notes

- In non-interactive mode, `ask` becomes block.
- File rules match both raw path and resolved absolute path.
- If you want Claude-like behavior, keep `defaultAction: "ask"` and grow `allow` / `deny` over time.
- If you want broad default allow with targeted prompts, set `defaultAction: "allow"` and use `ask` list.

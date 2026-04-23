# Changelog

## [0.2.2] - 2026-04-23

### Bug Fixes
- Match ask/allow/deny bash rules against RTK-rewritten git and gh commands by normalizing `rtk git`, `rtk proxy git`, `rtk gh`, and leading env assignments.

### Other
- Keep user `!` / `!!` bash commands outside permission handling.
- Add regression test for RTK-wrapped `git push` matching.

## [0.2.1] - 2026-04-23

### Other
- Fix repository URL

## [0.2.0] - 2026-04-23

### Features
- Initial release: Claude-style `allow` / `deny` / `ask` lists for Pi tool calls
- Session, project, and global decision persistence
- Compatible with `pi-lazy-tools` with `tool_search` allowed by default

## 0.1.0

- Initial release
- Claude-style `allow` / `deny` / `ask` lists for Pi tool calls
- Session, project, and global decisions
- Built for compatibility with `pi-lazy-tools` by always allowing `tool_search` by default

# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the version
numbers follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.0] — 2026-08-29

The first version. It is a first version: it works, it has been used, and it has
not been used by many people yet.

### Added

- **Picture checks.** Opens the real app, photographs the screens listed in the
  config, and compares each one against the picture a human approved. Anything
  that moved fails the run until a person looks at it and says yes.
- **Guards.** One check per bug that was already fixed once, named in plain
  language ("the sidebar still collapses"). The tool refuses names that read like
  code identifiers or issue numbers, because the name is what somebody has to
  understand six months later.
- **Walk.** Opens the built app before a release, walks the screens in order,
  photographs each step, and leaves behind a single page you can scroll through.
- **Markers.** Pins a known-good moment — a release, or just before something
  risky — and `trace` then reports the last marker where a screen still looked
  right, the first one where it did not, and the commits in between.
- **A flake register.** Every run is remembered. A check that changes its mind
  while the code stood still is recorded as a flake, and past the limit it is
  condemned and says so in red until a person fixes it or deletes it.
- **The freeze layer.** Frozen clock and time zone, animations and transitions
  stopped, seeded randomness, external network requests blocked or replayed from
  recorded fixtures, fonts and images waited for, text rasterisation pinned,
  scrollbars and text carets hidden, and a settle loop that only accepts a photo
  once two in a row agree.
- **An MCP server**, so Claude Code, Codex, Gemini CLI, Cursor and anything else
  that speaks the Model Context Protocol can check their own work the moment they
  finish editing. The approve tool is not offered to an agent unless the project
  explicitly opts in, and it is off by default.
- **Commands:** `init`, `check`, `approve`, `walk`, `mark`, `trace`, `status`,
  `flake`, `doctor`, `mcp`.
- **Web apps and Electron apps.** Config in JavaScript, or in JSON so a project
  in any language can use the tool without anybody writing JavaScript.
- Two runtime dependencies, `pngjs` and `pixelmatch`. No build step: the source
  in the repository is the code that runs.

### Known limits

- Not published to npm yet. Run it from GitHub: `npx staysfixed`.
- Approved pictures are tied to the operating system that took them. A picture
  approved on macOS will not match on Linux.
- Untested on Windows.
- Chromium-based rendering only — Chrome, Chromium, Edge, Brave, or the Chromium
  inside your Electron app. No Firefox, no WebKit.
- No phone or tablet simulators.
- No hosted service, no dashboard, no accounts.

[Unreleased]: https://github.com/asadev/staysfixed/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/asadev/staysfixed/releases/tag/v0.1.0

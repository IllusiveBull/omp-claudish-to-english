# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `/claudish last` now shows the rewrite of the last assistant message under
  the *current* settings instead of echoing the original text. If style,
  language, or model changed since the rewrite was displayed — e.g.
  `/claudish language Japanese` then `/claudish last` — the message is
  rewritten anew; otherwise the existing rewrite is replayed without another
  model call. The explicit request also bypasses the `min` length gate, so a
  message that was too short to be rewritten automatically can be rewritten on
  demand. The original text is always in the transcript already.

## [0.1.1] - 2026-09-02

### Fixed

- Agent-initiated follow-up turns no longer clobber the rewrite. Only the
  terminal message of a user-initiated turn is rewritten; a bonus turn the
  agent/host spawns on top of an already-finished answer — an advisor note the
  agent acknowledges, a stop-hook continuation, or any agent-injected steer that
  lands after a completed answer — is detected from the session branch and
  skipped. It is no longer rewritten, and it no longer aborts the pending
  rewrite of the answer that preceded it. The single pending-rewrite slot is
  therefore only ever cancelled by a genuine new user turn. An agent steer that
  reshapes an *in-flight* user turn still yields a real answer and is rewritten.

## [0.1.0] - 2026-09-02

Initial release — a TypeScript port of the
[claudish-to-english](https://github.com/gvzdv/claudish-to-english) Claude Code
plugin to the Oh My Pi (OMP) extension API.

### Added

- Plain-language rewrite of final assistant messages, appended to the
  transcript as a display-only custom message (`claudish-rewrite`).
- Context filter that strips rewrites from LLM context.
- Four rewrite styles: `default`, `tldr`, `5y`, `caveman`.
- Target-language override (`/claudish language <name>`).
- `/claudish` slash command: `on`, `off`, `style`, `language`, `model`,
  `min`, `last`, `reset`, and a status view.
- Environment-variable defaults: `CLAUDISH_MODE`, `CLAUDISH_STYLE`,
  `CLAUDISH_LANG`, `CLAUDISH_MODEL`, `CLAUDISH_MIN_CHARS`.
- Model resolution from the host only: explicit spec → `@tiny`/`@smol` role
  aliases → session model. No hardcoded model list.
- Host-pipeline completions (`completeSimple` + ModelRegistry resolver):
  inherits OMP model auth, including OAuth/token-exchange providers.
- Safety behavior: prose-length gate, tool-call message skipping,
  stale-rewrite cancellation, idle-wait append, 45 s timeout, fail-open
  error handling.

### Changed from the original plugin

- Shell hooks (`hooks.json`, `rewrite.sh`, `rewrite-md.sh`) replaced by
  in-process `message_end` / `context` event handlers.
- `providers.sh` (provider detection, API keys, HTTP) removed entirely —
  auth is inherited from the host session.
- File-based state replaced by in-memory per-session state.

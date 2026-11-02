# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/claudish save [path]` writes the last displayed rewrite to a Markdown
  file. Without a path it creates `claudish-<timestamp>.md` in the working
  directory; a path ending in `/` puts the timestamped file in that directory;
  `~/` is expanded and missing directories are created. Only the rewrite text
  is written — no separator, no original message.
- `/claudish copy` puts the last displayed rewrite on the clipboard, so it can
  be pasted without the `│` border that a terminal selection of the
  transcript picks up. Like `save`, it copies only the rewrite text. It uses
  OMP's clipboard helper: OSC 52 to the terminal (works over SSH) plus the
  native clipboard when one is available.
- The rewrite block ends with a footer naming the model that produced it and
  how long the rewrite took, e.g. ``*via `anthropic/claude-haiku-4-5` · 2.1 s*``.
  The time runs from job start (credential lookup included) to the model's
  reply; the wait for the session to go idle is excluded. `/claudish last`
  replays the original footer when it replays a cached rewrite. `/claudish
  save` still writes only the rewrite text.

### Changed

- Agent-initiated follow-up turns are no longer dropped from the rewrite. A
  follow-up that lands while the answer's rewrite is still in flight is merged
  into it: the rewrite is re-issued with the follow-up as a `<follow-up>`
  section, and the single plain-language block reflects the final position —
  essential when an advisor note reverses the answer's direction instead of
  confirming it. A follow-up that arrives after the rewrite has already been
  appended is rewritten on its own; the length gate filters short
  acknowledgements. A genuine new user turn still cancels any pending rewrite
  outright.
- `/claudish last` now shows the rewrite of the last assistant message under
  the *current* settings instead of echoing the original text. If style,
  language, or model changed since the rewrite was displayed — e.g.
  `/claudish language Japanese` then `/claudish last` — the message is
  rewritten anew; otherwise the existing rewrite is replayed without another
  model call. The explicit request also bypasses the `min` length gate, so a
  message that was too short to be rewritten automatically can be rewritten on
  demand. The original text is always in the transcript already.
- `/claudish last` records agent-initiated follow-ups too: a rewrite of a
  merged answer is re-issued with its `<follow-up>` sections intact.

### Fixed

- `/claudish last` works while rewrites are off. Messages are still recorded
  when `/claudish off` is active, so `last` rewrites the newest assistant
  message instead of replaying the last rewrite shown before turning off.
- A rewrite that finishes after a newer message arrived is no longer cached
  as that newer message's rewrite, so `/claudish last` never replays a stale
  rewrite.
- A failed rewrite no longer fails silently. Previously every error went to
  the debug log only, so `/claudish last` showed "rewriting last message" and
  then nothing, and automatic rewrites simply never appeared. A provider
  error, timeout, or empty reply now shows a warning with the model and the
  first line of the error.
- A rewrite model without a usable credential — e.g. a `@tiny` role on a
  provider whose OAuth refresh fails — no longer blocks rewriting. Candidates
  are checked in order (explicit spec → `@tiny` → `@smol` → session model) and
  keyless ones are skipped; if none has a key, a warning lists them.

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

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

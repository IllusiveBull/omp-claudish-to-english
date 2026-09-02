# omp-claudish-to-english

An [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP) extension. It rewrites the assistant's messages in plain language. It runs on the model providers OMP already has — no API keys to set up.

When the assistant finishes a long, jargon-heavy reply, claudish asks a cheap model to say it again in plain words. The result is added below the reply:

```
────────────────────────
💬 In plain **English**:

The build broke because two files disagree about one setting. I changed
src/config.ts so both use the same value, and the tests pass now.
```

The rewrite is **for your eyes only**. A filter keeps it out of the LLM context, so it never changes what the agent thinks. It is also only added once the session is idle, so it never gets in the way of a running turn.

This is a TypeScript port of [claudish-to-english](https://github.com/gvzdv/claudish-to-english) (a Claude Code plugin by Mike Gvozdev) to the OMP extension API. The original needs ~80 KB of shell to work around one problem: hooks run outside the host, so it must detect providers, hold API keys, and keep state files itself. OMP extensions run inside the host process, so all of that fits in one file.

## Native providers — no separate API setup

The original plugin lives outside the host, so it must bring its own way to reach models. Its cloud providers need an API key in the environment (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CLAUDISH_*_KEY`). No key, no rewrites. It also needs base-URL and model variables per provider. There are only two exceptions: the codex CLI's own login, and reading Claude's OAuth token from the keychain.

This port needs **no provider setup at all**. Completions go through the host's own pipeline (`completeSimple` + the ModelRegistry API-key resolver). So **every one of OMP's 60+ native providers just works** — including subscription and OAuth / token-exchange providers, which have no API key you could export. If a model shows up in OMP's model list, claudish can use it. Nothing to `export`, no base URL to set, no second credential to create or leak.

## Features

- **Four styles** — `default` (plain language), `tldr` (short summary), `5y` (explain like I'm five), `caveman` (ugh)
- **Any target language** — `/claudish language Spanish` makes every rewrite Spanish
- **Inherited auth** — uses the models you already set up in OMP; no extra API keys
- **Cheap by default** — tries the host's `@tiny` / `@smol` utility-model roles first, and only falls back to the session's own model
- **Non-intrusive** — skips short messages, skips messages with tool calls, waits until the session is idle, drops stale rewrites, and fails open (an error never breaks your session)

## Installation

Clone the repository anywhere:

```sh
git clone https://github.com/IllusiveBull/omp-claudish-to-english.git
```

Then load it in one of three ways:

**1. User-level config** (all projects) — add the directory to `~/.omp/agent/config.yml`:

```yaml
extensions:
  - ~/path/to/omp-claudish-to-english
```

OMP finds the entry point on its own, from the directory's `package.json#omp.extensions`.

**2. Project-level auto-discovery** — clone (or symlink) into `<repo>/.omp/extensions/`.

**3. One-off** — pass it on the command line:

```sh
omp -e ~/path/to/omp-claudish-to-english
```

You do not need `npm install`. The extension only imports packages the host already bundles (`@oh-my-pi/pi-ai`, `@oh-my-pi/pi-coding-agent`); OMP resolves them in-process at load time.

## Usage

Everything is controlled with the `/claudish` slash command:

| Command | Effect |
| --- | --- |
| `/claudish` | Show current status (mode, style, language, model, min length) |
| `/claudish on` / `off` | Turn rewrites on / off |
| `/claudish style tldr\|5y\|caveman\|default` | Switch rewrite style |
| `/claudish language <name>` | Rewrite in that language (empty = same language as the original message) |
| `/claudish model <spec>` | Pin the rewrite model (e.g. `openai/gpt-4.1-mini` or a role alias like `@slow`) |
| `/claudish min <chars>` | How long a message must be before it gets rewritten (non-whitespace chars, code blocks not counted) |
| `/claudish last` | Show the last original (pre-rewrite) assistant message again |
| `/claudish reset` | Put all settings back to their defaults |

Settings last for one session. Use the environment variables below for lasting defaults.

## Configuration

| Variable | Values | Default | Description |
| --- | --- | --- | --- |
| `CLAUDISH_MODE` | `append` \| `off` | `append` | Start on or off |
| `CLAUDISH_STYLE` | `default` \| `tldr` \| `5y` \| `caveman` | `default` | Starting style |
| `CLAUDISH_LANG` | any language name | *(auto)* | Language the rewrites are written in |
| `CLAUDISH_MODEL` | model spec or role alias | *(auto)* | Pin the rewrite model |
| `CLAUDISH_MIN_CHARS` | non-negative integer | `200` | Length gate for rewrites |

## How it works

1. `message_end` fires for each assistant message. Messages that carry tool calls are skipped — more work is coming. Only the terminal message of a **user-initiated** turn counts. A bonus turn the agent or host spawns on top of an already-finished answer — an advisor note the agent acknowledges, a stop-hook continuation, or any agent-injected steer landing after a completed answer — is detected from the session branch and skipped, so it never replaces the rewrite of the real answer.
2. Fenced code blocks are stripped, then non-whitespace characters are counted. Messages under the `min` limit are ignored.
3. A rewrite model is picked, cheapest first:
   1. the explicit `/claudish model` spec, if set;
   2. the host's `@tiny`, then `@smol` role aliases (skipping the session's own model);
   3. the session's own model — it is always authenticated.
4. The completion runs in the background with a 45 s timeout, through the host pipeline. OMP itself handles provider auth (OAuth refresh, token exchange, custom headers). A newer message cancels any rewrite still in flight.
5. The rewrite waits for the session to go idle (up to 20 s). Then it is added as a custom transcript message (`claudish-rewrite`, `triggerTurn: false`). If you already started a new turn, it is dropped instead.
6. A `context` filter removes `claudish-rewrite` messages from everything sent to the LLM.

## Development

```sh
bun install          # dev-only type packages; not needed to run
bun x tsc --noEmit   # type-check
```

The extension is one file, `src/index.ts`. It declares small structural types for the OMP runtime objects it touches, instead of depending on internal host types. That way it keeps loading across host versions.

## Credits

Concept and original implementation: [claudish-to-english](https://github.com/gvzdv/claudish-to-english) by Mike Gvozdev (MIT).

## License

[MIT](./LICENSE)

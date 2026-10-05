# voix

Local voice output for AI agents. One executable, one MCP tool, no cloud.

```text
Agent ──MCP──▶ voix ──▶ Kokoro (local ONNX) ──▶ your speakers
```

An agent gathers whatever it needs with its other tools, writes a spoken summary, and calls `speak`. voix synthesizes it with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) on the CPU and plays it. First audio starts in about a second; nothing leaves the machine.

**Supported platforms:** macOS on Apple Silicon and Linux x64 (glibc). See [docs/SPEC.md](docs/SPEC.md) for every design decision.

## Install

One line (installs to `~/.local/bin/voix`; set `VOIX_INSTALL_DIR` to change that):

```bash
curl -fsSL https://github.com/osmelmora/voix-mcp/releases/latest/download/install.sh | sh
```

The installer selects the matching release asset:

| Platform | Asset | Audio player |
| --- | --- | --- |
| macOS Apple Silicon | `voix-darwin-arm64` | built-in `afplay` |
| Linux x64 (glibc) | `voix-linux-x64` | tries `pw-play`, `paplay`, then `aplay` on `PATH`, advancing on failure |

Linux playback needs a working PipeWire, PulseAudio, or ALSA session. Install its client tools if necessary (for example, `pipewire-bin`, `pulseaudio-utils`, or `alsa-utils` on Ubuntu). Headless use with `voix say --out hello.wav "Hello"` needs no audio player or device. Alpine/musl, Linux arm64, Intel Macs, and Windows do not have supported binaries yet.

Or download the executable from the [latest release](https://github.com/osmelmora/voix-mcp/releases/latest) and put it on your `PATH`. For macOS Apple Silicon:

```bash
curl -fsSL -o voix https://github.com/osmelmora/voix-mcp/releases/latest/download/voix-darwin-arm64
chmod +x voix && mv voix ~/.local/bin/voix
```

For Linux x64, use `voix-linux-x64` in the download URL instead.

Or build it yourself (needs [Bun](https://bun.sh) 1.4.2 (pinned in mise.toml)):

```bash
git clone https://github.com/osmelmora/voix-mcp && cd voix-mcp
bun install
bun run build            # → dist/voix-<platform>-<arch> for the current supported host
# Cross-compile explicitly: bun run build bun-linux-x64
# Copy the matching executable from dist/ to ~/.local/bin/voix
```

The macOS binary is not code-signed. `curl` downloads run as-is; if you downloaded it with a browser run `xattr -d com.apple.quarantine ~/.local/bin/voix` once.

## First run

```bash
voix say "Hello"
```

On first use voix downloads the Kokoro model (326 MB, fp32, Apache-2.0) into `~/.cache/voix` and verifies its SHA-256. After that everything is offline. To do the download ahead of time:

```bash
voix setup
```

## Connect an agent

Add voix to your MCP client configuration (Claude Code, Claude Desktop, Cursor, ...):

```json
{
  "mcpServers": {
    "voix": { "command": "voix", "args": ["mcp"] }
  }
}
```

If `voix` is not on the client's `PATH`, use the absolute path, for example `"/Users/you/.local/bin/voix"`.

The agent gets two tools:

| tool | what it does |
| --- | --- |
| `speak` `{ text, voice?, speed? }` | Speak text. Returns when the player has started for the first audio batch (or `queued` if another utterance is active). |
| `stop` | Stop immediately and drop the queue. |

Errors come back as typed tool errors (`EmptyText`, `TextTooLong`, `InvalidVoice`, `InvalidSpeed`, `ModelDownloading`, `DownloadFailed`, `ChecksumMismatch`, `PlayerNotFound`, `PlaybackFailed`, `SynthFailed`). The server also publishes short usage instructions and the resource `skill://voix/SKILL.md`, which is the same text as [skills/voix/SKILL.md](skills/voix/SKILL.md). Copy that folder into your agent's skills directory if it supports skills.

Then try:

> Give me my daily update out loud.

## CLI

```bash
voix say "Build finished."                 # speak
echo "Deploy done." | voix say             # from stdin
voix say --voice bm_george --speed 1.1 "Good evening."
voix say --out hello.wav "Hello"           # write a WAV instead of playing
voix voices                                # 28 English voices, * marks the default (af_heart)
voix status                                # model, cache, player, runtime
voix setup                                 # download the model now
voix mcp                                   # MCP server over stdio
```

## Configuration

There is no config file. Defaults: voice `af_heart`, speed `1.0`.

| variable           | effect                                            |
| ------------------ | ------------------------------------------------- |
| `VOIX_HOME`        | where models are stored (default `~/.cache/voix`) |
| `VOIX_PLAYER=none` | disable audio output (tests, CI)                  |

## How it works

- **Runtime:** TypeScript on Bun, compiled with `bun build --compile`. Effect 4 for services, typed errors, the queue, interruption, and the MCP and CLI layers.
- **Inference:** `onnxruntime-node` on the CPU with about 150 lines of Kokoro glue and the eSpeak NG phonemizer in WebAssembly. No Python, no transformers.js. voix forces `ORT_DISABLE_TELEMETRY=1` before loading the native runtime, disabling its bundled telemetry.
- **Pipelining:** text is split into sentences; the first plays while the rest synthesize, and each later playback chunk is everything that finished in the meantime.
- **Playback:** a temp WAV played by `/usr/bin/afplay` on macOS, or `pw-play` / `paplay` / `aplay` on Linux, as a scoped child process killed on `stop`, on request cancellation, and on exit. Linux plays one silent sample to check the sound server/device before reporting startup, trying the next installed backend on failure. Each check has a five-second deadline. Every utterance is checked before its first batch is acknowledged; later batches are not. The backend that last played successfully is tried first. Cancellation never retries. If a player fails after partially playing, fallback may replay that batch. `voix say` waits for completion and exits nonzero if synthesis or every available player fails, or if no audio starts within 45 seconds.
- **What is inside the binary:** Bun runtime, the ONNX Runtime library, 28 voice files, the tokenizer, the code. Only the model is downloaded.

## Development

Use [mise](https://mise.jdx.dev) to install and activate the Bun, Node.js, hk, Pkl, and cocogitto versions pinned in `mise.toml`. Node runs the lint and format tooling. mise also puts `node_modules/.bin` on `PATH`. CI uses the same mise configuration.

Linting and formatting use [Ultracite](https://www.ultracite.ai/docs/provider/oxlint) with Oxlint and Oxfmt. Run `bun run check` to check both, or `bun run fix` to apply automatic fixes. The CI workflow checks commit messages, linting, formatting, types, and tests on every push to `main` and every pull request.

[Dillon Mulroy's anti-slop rules](https://github.com/dmmulroy/anti-slop) run alongside Ultracite: all 18 generic rules, all five Effect rules, and `oxc/no-accumulating-spread` are errors. See [the vendoring record](tools/oxlint/anti-slop/UPSTREAM.md) for provenance, licenses, and update guidance. Keep `oxlint` and `@oxlint/plugins` pinned to the same version when upgrading.

Cyclomatic complexity is capped at 15 per function, overriding Ultracite's default limit of 20.

Git hooks run through [hk](https://hk.jdx.dev), configured in `hk.pkl`. The pre-commit hook runs Oxlint, Oxfmt, and `tsc` on staged files and stages automatic fixes. The commit-msg hook requires [Conventional Commits](https://www.conventionalcommits.org) subjects such as `feat(mcp): add stop tool`. The pre-push hook runs the same checks and the tests. Run `hk check --all` to check everything at once, or `hk fix --all` to apply fixes. Set `HK=0` to skip the hooks once.

Releases run in CI with [cocogitto](https://docs.cocogitto.io), configured in `cog.toml`. When the commits since the last tag call for a bump (`feat` → minor; `fix` or `perf` → patch; a breaking change → minor while the version is 0.x, so 1.0.0 is a manual release), a push to `main` builds and tests both binaries with the next version. Once both pass, CI commits that version to `package.json` and `CHANGELOG.md` as `github-actions[bot]`, tags it, and publishes a GitHub release with the binaries, the installer, and that version's changelog entry as notes. Other pushes are plain CI runs, and commits pushed with `[skip ci]` are released by the next run on `main`. CI is the only thing that tags: don't run `cog bump` or push tags yourself, and pull after a release to get the bump commit. If the release job fails, re-run it; when its tag was already pushed, it publishes without bumping again. If `main` moves on during a release, the job leaves the release to the CI run for the newer commit, or stops when a published release already contains its commit; when neither covers it, the job fails and its error says which run to start or re-run. A release always covers every commit since the last tag, so if the newer run fails or is cancelled, re-running it (or the next green run on `main`) releases the commits it took over.

To release by hand, run the `ci` workflow on `main` from the Actions tab. It takes a bump (`auto`, `patch`, `minor`, or `major`), an exact `X.Y.Z` version that overrides the bump, and a dry run that builds and tests the release without publishing it. `ci`, `chore`, `style`, and `test` commits stay out of the changelog. Keep GitHub's default merge title ("Merge pull request #N from …") when merging a pull request: cog 7.0.0 lists a merge commit with a conventional title in the changelog next to the commit it merges, so the change appears twice. Run `cog changelog` to preview unreleased changes.

```bash
mise install
bun install
hk install --mise                  # install the git hooks
hk check --all                     # lint, format, and type check
VOIX_PLAYER=none bun test          # synthesis and MCP tests run only if the model is cached
bun run src/main.ts say "dev mode"
bun run build
bun run scripts/smoke.ts ./dist/voix-darwin-arm64 # use voix-linux-x64 on Linux
VOIX_BIN=./dist/voix-darwin-arm64 VOIX_PLAYER=none bun test tests/mcp.test.ts
```

## Known limitations

- Supported binaries are darwin-arm64 and linux-x64 (glibc). Linux arm64, Windows, Intel Macs, and musl are not supported yet.
- English voices only. Kokoro's other languages need a different grapheme-to-phoneme stack.
- The embedded eSpeak NG build is GPL-3; see [NOTICE](NOTICE).

## License

MIT for voix. Third-party components are listed in [NOTICE](NOTICE).

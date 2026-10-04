# voix

Local voice output for AI agents. One executable, one MCP tool, no cloud.

```text
Agent ──MCP──▶ voix ──▶ Kokoro (local ONNX) ──▶ your speakers
```

An agent gathers whatever it needs with its other tools, writes a spoken summary, and calls `speak`. voix synthesizes it with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) on the CPU and plays it. First audio starts in about a second; nothing leaves the machine.

**MVP scope:** macOS on Apple Silicon. See [docs/SPEC.md](docs/SPEC.md) for every design decision.

## Install

Download the executable and put it on your `PATH`:

```bash
curl -fsSL https://github.com/osmelmora/voix-mcp/releases/latest/download/install.sh | sh
```

or build it yourself (needs [Bun](https://bun.sh) 1.4.2 (pinned in mise.toml)):

```bash
git clone https://github.com/osmelmora/voix-mcp && cd voix-mcp
bun install
bun run build            # → dist/voix-darwin-arm64 (≈120 MB)
cp dist/voix-darwin-arm64 ~/.local/bin/voix
```

The binary is not code-signed. `curl` downloads run as-is; if you downloaded it with a browser run `xattr -d com.apple.quarantine ~/.local/bin/voix` once.

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
| `speak` `{ text, voice?, speed? }` | Speak text. Returns as soon as the first sentence starts playing (or `queued` if something else is playing). |
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
- **Inference:** `onnxruntime-node` on the CPU with about 150 lines of Kokoro glue and the eSpeak NG phonemizer in WebAssembly. No Python, no transformers.js.
- **Pipelining:** text is split into sentences; the first plays while the rest synthesize, and each later playback chunk is everything that finished in the meantime.
- **Playback:** a temp WAV played by `/usr/bin/afplay` as a scoped child process, killed on `stop`, on request cancellation, and on exit.
- **What is inside the binary:** Bun runtime, the ONNX Runtime library, 28 voice files, the tokenizer, the code. Only the model is downloaded.

## Development

Use [mise](https://mise.jdx.dev) to install and activate the Bun, Node.js, hk, Pkl, and cocogitto versions pinned in `mise.toml`. Node runs the lint and format tooling. mise also puts `node_modules/.bin` on `PATH`. The release workflow uses the same mise configuration.

Linting and formatting use [Ultracite](https://www.ultracite.ai/docs/provider/oxlint) with Oxlint and Oxfmt. Run `bun run check` to check both, or `bun run fix` to apply automatic fixes. The CI workflow checks commit messages, linting, formatting, types, and tests on every push to `main` and every pull request; the release workflow repeats those checks before building.

Git hooks run through [hk](https://hk.jdx.dev), configured in `hk.pkl`. The pre-commit hook runs Oxlint, Oxfmt, and `tsc` on staged files and stages automatic fixes. The commit-msg hook requires [Conventional Commits](https://www.conventionalcommits.org) subjects such as `feat(mcp): add stop tool`. The pre-push hook runs the same checks and the tests. Run `hk check --all` to check everything at once, or `hk fix --all` to apply fixes. Set `HK=0` to skip the hooks once.

Releases use [cocogitto](https://docs.cocogitto.io), configured in `cog.toml`. `cog bump --auto` picks the next version from the commits since the last tag, sets it in `package.json`, prepends the release to `CHANGELOG.md`, then commits and tags it. Pushing the tag runs the release workflow, which uses that version's changelog entry as the GitHub release notes. Run `cog changelog` to preview unreleased changes.

```bash
mise install
bun install
hk install --mise                  # install the git hooks
hk check --all                     # lint, format, and type check
VOIX_PLAYER=none bun test          # synthesis and MCP tests run only if the model is cached
bun run src/main.ts say "dev mode"
bun run build && VOIX_BIN=./dist/voix-darwin-arm64 VOIX_PLAYER=none bun test tests/mcp.test.ts
```

## Known limitations

- darwin-arm64 only. Linux and Windows cross-compile but are untested; Intel Macs lack a prebuilt ONNX Runtime in this version.
- English voices only. Kokoro's other languages need a different grapheme-to-phoneme stack.
- The embedded eSpeak NG build is GPL-3; see [NOTICE](NOTICE).

## License

MIT for voix. Third-party components are listed in [NOTICE](NOTICE).

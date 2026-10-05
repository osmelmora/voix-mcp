import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const source = process.argv.at(2);

if (source === undefined) {
  throw new Error("usage: bun run scripts/smoke.ts <compiled executable>");
}

// Run a copy from outside the checkout, with a fresh native-library extraction directory.
const directory = mkdtempSync(path.join(os.tmpdir(), "voix-smoke-"));

const executable = path.join(directory, "voix");

const temp = path.join(directory, "tmp");

const wav = path.join(directory, "speech.wav");

const run = (
  args: readonly string[],
  tmpdir: string | undefined,
  timeout = 180_000
) => {
  const result = Bun.spawnSync([executable, ...args], {
    cwd: directory,
    env: {
      ...process.env,
      BUN_TMPDIR: undefined,
      TEMP: undefined,
      TMP: undefined,
      TMPDIR: tmpdir,
      VOIX_PLAYER: "none",
    },
    stderr: "inherit",
    stdout: "inherit",
    timeout,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `compiled smoke command failed: ${args.join(" ")} (${result.exitCode})`
    );
  }
};

const synthesize = (tmpdir?: string) => {
  run(["say", "--out", wav, "Hello from voix."], tmpdir);
  const data = readFileSync(wav);

  // Check the fixed WAV format independently so shared encoder offsets cannot hide a regression.
  if (
    data.toString("ascii", 0, 4) !== "RIFF" ||
    data.toString("ascii", 8, 12) !== "WAVE" ||
    data.readUInt32LE(24) !== 24_000 ||
    data.readUInt16LE(22) !== 1 ||
    data.readUInt16LE(34) !== 16 ||
    data.length <= 44 ||
    data.readUInt32LE(40) !== data.length - 44
  ) {
    throw new Error(
      "compiled binary did not produce a nonempty mono 24 kHz PCM WAV"
    );
  }

  rmSync(wav);
};

try {
  copyFileSync(path.resolve(source), executable);
  chmodSync(executable, 0o755);
  mkdirSync(temp);
  run(["status"], temp);
  // Keep cold-cache download time separate from the synthesis deadline.
  run(["setup"], temp, 600_000);
  synthesize(temp);

  // Exercise the /tmp fallback on both platforms, including the macOS dylib copy.
  synthesize();

  console.log("compiled smoke passed");
} finally {
  rmSync(directory, { force: true, recursive: true });
}

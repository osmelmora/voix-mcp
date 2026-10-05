import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { Effect } from "effect";

import { waitUntil } from "./helpers/process.ts";
import { useShellFixtures } from "./helpers/shell.ts";

const createFixture = useShellFixtures("voix-player-test-");

const fixture = () => {
  const shell = createFixture();
  const { directory } = shell;

  const attemptsFile = path.join(directory, "attempts");
  const pidFile = path.join(directory, "pid");
  const wavFile = path.join(directory, "wav");

  const command = (
    name: string,
    body = "exit 0",
    options: { readonly executable?: boolean } = {}
  ) =>
    shell.command(
      name,
      `printf '%s\\n' "$1" > "$VOIX_TEST_WAV"\nprintf '%s\\n' "${name}" >> "$VOIX_TEST_ATTEMPTS"\n${body}`,
      options
    );

  const start = (
    options: {
      readonly fromEnv?: boolean;
      readonly waitForPlayer?: boolean;
      readonly repeat?: boolean;
      readonly nextUtterance?: boolean;
    } = {}
  ) =>
    Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, "fixtures/play.ts"),
        ...(options.fromEnv ? ["--from-env"] : []),
        ...(options.waitForPlayer ? ["--wait-for-player"] : []),
        ...(options.repeat ? ["--repeat"] : []),
        ...(options.nextUtterance ? ["--next-utterance"] : []),
      ],
      {
        env: {
          ...process.env,
          PATH: directory,
          VOIX_PLAYER: options.fromEnv ? "none" : "",
          VOIX_TEST_ATTEMPTS: attemptsFile,
          VOIX_TEST_PID: pidFile,
          VOIX_TEST_WAV: wavFile,
        },
        stderr: "pipe",
        stdin: "pipe",
        stdout: "pipe",
      }
    );

  return {
    attempts: () => readFileSync(attemptsFile, "utf-8"),
    command,
    hasWav: () => existsSync(wavFile),
    killPlayer: () => {
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, "utf-8")), "SIGKILL");
        } catch {
          // The child has already exited in the successful case.
        }
      }
    },
    pidFile,
    start,
    wavPath: () => readFileSync(wavFile, "utf-8").trim(),
  };
};

describe("Linux playback", () => {
  test.each([
    [["pw-play", "paplay", "aplay"], "pw-play"],
    [["paplay", "aplay"], "paplay"],
    [["aplay"], "aplay"],
  ] as const)(
    "selects the first available player in %j",
    async (commands, expected) => {
      const playerFixture = fixture();

      for (const name of commands) {
        playerFixture.command(name);
      }

      const proc = playerFixture.start();
      expect(await proc.exited).toBe(0);
      const output = await new Response(proc.stdout).text();
      expect(output.trim()).toContain(expected);
      expect(playerFixture.attempts()).toBe(`${expected}\n${expected}\n`);

      const wav = playerFixture.wavPath();

      expect(wav.endsWith(".wav")).toBe(true);
      expect(existsSync(wav)).toBe(false);
    }
  );

  test("skips non-executable players", async () => {
    const playerFixture = fixture();
    playerFixture.command("pw-play", "exit 0", { executable: false });
    playerFixture.command("paplay");
    const proc = playerFixture.start();
    expect(await proc.exited).toBe(0);
    const output = await new Response(proc.stdout).text();
    expect(output.trim()).toBe("paplay");
  });

  test("discovers players installed after the service starts", async () => {
    const playerFixture = fixture();
    const proc = playerFixture.start({ waitForPlayer: true });
    const reader = proc.stdout.getReader();

    try {
      const { value } = await reader.read();
      expect(new TextDecoder().decode(value).trim()).toBe("unavailable");
      playerFixture.command("aplay");
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
      expect(playerFixture.attempts()).toBe("aplay\naplay\n");
    } finally {
      reader.releaseLock();
      proc.kill();
      await proc.exited;
    }
  });

  test("reports PlayerNotFound when no player is installed", async () => {
    const playerFixture = fixture();
    const proc = playerFixture.start();
    expect(await proc.exited).toBe(1);
    const output = await new Response(proc.stdout).text();
    const errors = await new Response(proc.stderr).text();
    expect(output + errors).toContain("No audio player available on linux");
    expect(playerFixture.hasWav()).toBe(false);
  });

  test("falls back to PulseAudio when the installed PipeWire player fails", async () => {
    const playerFixture = fixture();
    playerFixture.command("pw-play", "exit 7");
    playerFixture.command("paplay");
    const proc = playerFixture.start();
    expect(await proc.exited).toBe(0);
    expect(playerFixture.attempts()).toBe("pw-play\npaplay\npaplay\n");

    const wav = playerFixture.wavPath();

    expect(existsSync(wav)).toBe(false);
  });

  test("falls back to ALSA after both sound-server clients fail", async () => {
    const playerFixture = fixture();
    playerFixture.command("pw-play", "exit 7");
    playerFixture.command("paplay", "exit 8");
    playerFixture.command("aplay");
    const proc = playerFixture.start();
    expect(await proc.exited).toBe(0);
    expect(playerFixture.attempts()).toBe("pw-play\npaplay\naplay\naplay\n");
  });

  test("reports every failed player when none can play", async () => {
    const playerFixture = fixture();
    playerFixture.command("pw-play", "exit 7");
    playerFixture.command("paplay", "exit 8");
    const proc = playerFixture.start();
    expect(await proc.exited).toBe(1);
    const output = await new Response(proc.stdout).text();
    const errors = await new Response(proc.stderr).text();
    expect(output + errors).toContain("pw-play exited with code 7");
    expect(output + errors).toContain("paplay exited with code 8");

    const wav = playerFixture.wavPath();

    expect(existsSync(wav)).toBe(false);
  });

  test("interrupting playback terminates the child and removes the WAV", async () => {
    const playerFixture = fixture();
    playerFixture.command(
      "pw-play",
      'printf "%s\\n" "$$" > "$VOIX_TEST_PID"\ntrap \'\' TERM\nexec /bin/sleep 30'
    );
    playerFixture.command("paplay");
    const proc = playerFixture.start();

    try {
      const { pidFile } = playerFixture;
      await waitUntil(() => existsSync(pidFile));

      expect(existsSync(pidFile)).toBe(true);
      const pid = Number(readFileSync(pidFile, "utf-8").trim());

      const wav = playerFixture.wavPath();

      expect(existsSync(wav)).toBe(true);
      proc.kill("SIGINT");
      await waitUntil(() => proc.exitCode !== null);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(existsSync(wav)).toBe(false);
      expect(playerFixture.attempts()).toBe("pw-play\n");
    } finally {
      playerFixture.killPlayer();
      proc.kill();
      await proc.exited;
    }
  }, 10_000);

  test("a startup timeout kills a player that ignores SIGTERM and tries the next backend", async () => {
    const playerFixture = fixture();
    playerFixture.command(
      "pw-play",
      'printf "%s\\n" "$$" > "$VOIX_TEST_PID"\ntrap \'\' TERM\nexec /bin/sleep 30'
    );
    playerFixture.command("paplay");
    const proc = playerFixture.start();

    try {
      const exitCode = await Effect.runPromise(
        Effect.promise(() => proc.exited).pipe(Effect.timeout("8 seconds"))
      );

      expect(exitCode).toBe(0);
      const pid = Number(readFileSync(playerFixture.pidFile, "utf-8"));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(playerFixture.attempts()).toBe("pw-play\npaplay\npaplay\n");
      expect(existsSync(playerFixture.wavPath())).toBe(false);
    } finally {
      playerFixture.killPlayer();
      proc.kill();
      await proc.exited;
    }
  }, 10_000);

  test("checks only the first batch of an utterance", async () => {
    const playerFixture = fixture();
    playerFixture.command("pw-play", "exit 7");
    playerFixture.command("paplay");
    const proc = playerFixture.start({ repeat: true });
    expect(await proc.exited).toBe(0);
    // pw-play fails its check; paplay is checked, plays the first batch, then the second without a check.
    expect(playerFixture.attempts()).toBe("pw-play\npaplay\npaplay\npaplay\n");
  });

  test("checks every utterance, starting with the backend that last worked", async () => {
    const playerFixture = fixture();
    playerFixture.command("pw-play", "exit 7");
    playerFixture.command("paplay");
    const proc = playerFixture.start({ nextUtterance: true });
    expect(await proc.exited).toBe(0);
    // The second utterance checks paplay again and never retries the failed pw-play.
    expect(playerFixture.attempts()).toBe(
      "pw-play\npaplay\npaplay\npaplay\npaplay\n"
    );
  });

  test("a remembered backend that stops working fails its next check", async () => {
    const playerFixture = fixture();
    // Succeeds for its startup check and first utterance, then fails like a vanished sound server.
    playerFixture.command(
      "paplay",
      'count=0\n[ -f "$0.count" ] && read -r count < "$0.count"\necho $((count + 1)) > "$0.count"\n[ "$count" -lt 2 ]'
    );
    playerFixture.command("aplay");
    const proc = playerFixture.start({ nextUtterance: true });
    expect(await proc.exited).toBe(0);
    expect(playerFixture.attempts()).toBe(
      "paplay\npaplay\npaplay\naplay\naplay\n"
    );
  });

  test("VOIX_PLAYER=none works without an installed player", async () => {
    const proc = fixture().start({ fromEnv: true });
    expect(await proc.exited).toBe(0);
    const output = await new Response(proc.stdout).text();
    expect(output.trim()).toBe("none");
  });
});

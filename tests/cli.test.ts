import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { voixHome } from "../src/core/paths.ts";
import { MAX_TEXT_LENGTH } from "../src/core/text.ts";
import { isModelInstalled } from "../src/providers/kokoro/model.ts";
import { failsAfterStartupCheck } from "./helpers/player.ts";
import { cliCommand } from "./helpers/process.ts";
import { useShellFixtures } from "./helpers/shell.ts";

const createFixture = useShellFixtures("voix-cli-test-");

const cli = cliCommand();

const runSay = (player: "missing" | "failed") => {
  const shell = createFixture();
  const { directory } = shell;

  if (player === "failed") {
    shell.command("aplay", failsAfterStartupCheck(7));
  }

  return Bun.spawnSync([...cli, "say", "Hello."], {
    env: { ...process.env, PATH: directory, VOIX_PLAYER: "" },
    timeout: 30_000,
  });
};

describe.skipIf(process.platform !== "linux" || !isModelInstalled())(
  "CLI playback exit codes",
  () => {
    test("returns failure when no player is installed", () => {
      const result = runSay("missing");
      expect(new TextDecoder().decode(result.stderr)).toContain(
        "No audio player available on linux"
      );
      expect(result.exitCode).toBe(1);
    });

    test("returns failure when the player fails after speech starts", () => {
      const result = runSay("failed");
      expect(new TextDecoder().decode(result.stderr)).toContain(
        "aplay exited with code 7"
      );
      expect(result.exitCode).toBe(1);
    });
  }
);

const sayOut = (args: readonly string[], home: string) => {
  const { directory } = createFixture();
  const out = path.join(directory, "out.wav");

  const result = Bun.spawnSync([...cli, "say", "--out", out, ...args], {
    env: { ...process.env, VOIX_HOME: home, VOIX_PLAYER: "none" },
    timeout: 60_000,
  });

  return {
    exitCode: result.exitCode,
    out,
    stderr: new TextDecoder().decode(result.stderr),
  };
};

// Validation runs before the model is touched, so these pass without it on every platform.
describe("say --out rejects what playback rejects", () => {
  test.each([
    { args: ["--speed", "9", "Hello."], error: "Speed 9 is out of range" },
    {
      args: ["a".repeat(MAX_TEXT_LENGTH + 1)],
      error: `Text is ${MAX_TEXT_LENGTH + 1} characters`,
    },
    { args: ["****"], error: "Nothing to speak" },
    { args: ["--voice", "nope", "Hello."], error: 'Unknown voice "nope"' },
  ])("$error, with no model and no output file", ({ args, error }) => {
    const home = createFixture().directory;
    const result = sayOut(args, home);

    expect(result.stderr).toContain(`error: ${error}`);
    expect(result.exitCode).toBe(1);
    expect(existsSync(result.out)).toBe(false);
    expect(existsSync(path.join(home, "models"))).toBe(false);
  });

  test("leaves an existing output file untouched", () => {
    const home = createFixture().directory;
    const { directory } = createFixture();
    const out = path.join(directory, "keep.wav");
    writeFileSync(out, "keep");

    const result = Bun.spawnSync([...cli, "say", "--out", out, "****"], {
      env: { ...process.env, VOIX_HOME: home, VOIX_PLAYER: "none" },
      timeout: 60_000,
    });

    expect(result.exitCode).toBe(1);
    expect(readFileSync(out, "utf-8")).toBe("keep");
  });
});

describe.skipIf(!isModelInstalled())("say --out with the model", () => {
  test("writes a WAV", () => {
    const result = sayOut(["Hello."], voixHome());

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(statSync(result.out).size).toBeGreaterThan(44);
  }, 60_000);
});

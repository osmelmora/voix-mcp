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

const sayOut = (
  args: readonly string[],
  home: string,
  timeout: number,
  out = path.join(createFixture().directory, "out.wav")
) => {
  const result = Bun.spawnSync([...cli, "say", "--out", out, ...args], {
    env: { ...process.env, VOIX_HOME: home, VOIX_PLAYER: "none" },
    timeout,
  });

  return {
    exitCode: result.exitCode,
    out,
    stderr: new TextDecoder().decode(result.stderr),
  };
};

const SENTINEL = "not a directory";

// A file where the models directory belongs, so any attempt to prepare the
// model fails locally at mkdir, before the download can start.
const blockedHome = () => {
  const home = createFixture().directory;
  const models = path.join(home, "models");
  writeFileSync(models, SENTINEL);

  return {
    home,
    untouched: () =>
      statSync(models).isFile() && readFileSync(models, "utf-8") === SENTINEL,
  };
};

// Startup only; a regression that reaches model preparation fails fast too.
const REJECT_TIMEOUT = 5000;

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
    const { home, untouched } = blockedHome();
    const result = sayOut(args, home, REJECT_TIMEOUT);

    expect(result.stderr).toContain(`error: ${error}`);
    expect(result.exitCode).toBe(1);
    expect(existsSync(result.out)).toBe(false);
    expect(untouched()).toBe(true);
  });

  test("leaves an existing output file untouched", () => {
    const { home, untouched } = blockedHome();
    const out = path.join(createFixture().directory, "keep.wav");
    writeFileSync(out, "keep");

    const result = sayOut(["****"], home, REJECT_TIMEOUT, out);

    expect(result.stderr).toContain("error: Nothing to speak");
    expect(result.exitCode).toBe(1);
    expect(readFileSync(out, "utf-8")).toBe("keep");
    expect(untouched()).toBe(true);
  });
});

describe.skipIf(!isModelInstalled())("say --out with the model", () => {
  test("writes a WAV", () => {
    const result = sayOut(["Hello."], voixHome(), 60_000);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(statSync(result.out).size).toBeGreaterThan(44);
  }, 60_000);
});

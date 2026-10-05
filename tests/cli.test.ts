import { describe, expect, test } from "bun:test";

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

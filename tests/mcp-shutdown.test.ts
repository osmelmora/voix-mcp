import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Server } from "bun";

import { KOKORO_MODEL } from "../src/providers/kokoro/model.ts";
import { serveStalledModel } from "./helpers/model-server.ts";
import { cliCommand, waitUntil } from "./helpers/process.ts";

/** How long the server may take to exit after stdin closes; a leaked download would hold it open. */
const EXIT_DEADLINE_MS = 5000;

const INITIALIZE = {
  id: 1,
  jsonrpc: "2.0",
  method: "initialize",
  params: {
    capabilities: {},
    clientInfo: { name: "voix-shutdown-test", version: "0" },
    protocolVersion: "2025-06-18",
  },
};

/** Wait for the exit code, killing the server if it outlives the deadline so the test fails instead of hanging. */
const exitWithin = async (proc: {
  exited: Promise<number>;
  kill: () => void;
}) => {
  const timer = setTimeout(() => proc.kill(), EXIT_DEADLINE_MS);
  const code = await proc.exited;
  clearTimeout(timer);

  return code;
};

const readFirstLine = async (stream: ReadableStream<Uint8Array>) => {
  let text = "";

  for await (const chunk of stream) {
    text += new TextDecoder().decode(chunk);

    if (text.includes("\n")) {
      break;
    }
  }

  return text.slice(0, text.indexOf("\n"));
};

describe("voix mcp shutdown on a cold cache", () => {
  let stalled: ReturnType<typeof serveStalledModel>;
  let server: Server<undefined>;
  let home: string;

  beforeAll(() => {
    stalled = serveStalledModel();
    ({ server } = stalled);
  });

  afterAll(async () => {
    await server.stop(true);
  });

  const freshEnv = () => {
    home = mkdtempSync(path.join(os.tmpdir(), "voix-mcp-shutdown-"));

    return {
      ...process.env,
      VOIX_HOME: home,
      VOIX_MODEL_URL: server.url.href,
      VOIX_PLAYER: "none",
    };
  };

  const pipeOptions = { stderr: "pipe", stdout: "pipe" } as const;

  /** Only the `.part` file may remain: nothing at the model path that a later size check could accept. */
  const expectNoModel = () => {
    const dir = path.join(home, "models", `kokoro-${KOKORO_MODEL.version}`);
    expect(existsSync(path.join(dir, "model.onnx"))).toBe(false);

    if (existsSync(dir)) {
      expect(readdirSync(dir).filter((f) => f !== "model.onnx.part")).toEqual(
        []
      );
    }

    rmSync(home, { force: true, recursive: true });
  };

  test("closing stdin during the model download exits 0", async () => {
    const before = stalled.requests();

    const proc = Bun.spawn([...cliCommand(), "mcp"], {
      ...pipeOptions,
      env: freshEnv(),
      stdin: "pipe",
    });

    const stderr = new Response(proc.stderr).text();

    proc.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
    proc.stdin.flush();

    const response = JSON.parse(await readFirstLine(proc.stdout));
    expect(response.result.serverInfo.name).toBe("voix");

    await waitUntil(() => stalled.requests() > before);
    proc.stdin.end();

    expect(await exitWithin(proc), await stderr).toBe(0);
    expectNoModel();
  }, 30_000);

  test("empty stdin exits 0 without waiting for the download", async () => {
    const proc = Bun.spawn([...cliCommand(), "mcp"], {
      ...pipeOptions,
      env: freshEnv(),
      stdin: new Blob([]),
    });

    const stderr = new Response(proc.stderr).text();

    expect(await exitWithin(proc), await stderr).toBe(0);
    expectNoModel();
  }, 30_000);
});

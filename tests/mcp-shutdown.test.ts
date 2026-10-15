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

/** Only a download's temp file may remain: nothing at the model path that a later size check could accept. */
const expectNoModel = (home: string) => {
  const dir = path.join(home, "models", `kokoro-${KOKORO_MODEL.version}`);
  expect(existsSync(path.join(dir, "model.onnx"))).toBe(false);

  if (existsSync(dir)) {
    expect(readdirSync(dir).filter((f) => !f.endsWith(".part"))).toEqual([]);
  }
};

describe("voix mcp shutdown on a cold cache", () => {
  let stalled: ReturnType<typeof serveStalledModel>;
  let server: Server<undefined>;

  beforeAll(() => {
    stalled = serveStalledModel();
    ({ server } = stalled);
  });

  afterAll(async () => {
    await server.stop(true);
  });

  /** Each test gets its own cache, so tests running concurrently never share or delete each other's files. */
  const coldServer = () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "voix-mcp-shutdown-"));

    const proc = Bun.spawn([...cliCommand(), "mcp"], {
      env: {
        ...process.env,
        VOIX_HOME: home,
        VOIX_MODEL_URL: server.url.href,
        VOIX_PLAYER: "none",
      },
      stderr: "pipe",
      stdin: "pipe",
      stdout: "pipe",
    });

    const cleanup = () => {
      proc.kill("SIGKILL");
      rmSync(home, { force: true, recursive: true });
    };

    return { cleanup, home, proc, stderr: new Response(proc.stderr).text() };
  };

  test("closing stdin during the model download exits 0", async () => {
    const { cleanup, home, proc, stderr } = coldServer();

    try {
      const before = stalled.requests();

      proc.stdin.write(`${JSON.stringify(INITIALIZE)}\n`);
      proc.stdin.flush();

      const response = JSON.parse(await readFirstLine(proc.stdout));
      expect(response.result.serverInfo.name).toBe("voix");

      await waitUntil(() => stalled.requests() > before);
      proc.stdin.end();

      expect(await exitWithin(proc), await stderr).toBe(0);
      expectNoModel(home);
    } finally {
      cleanup();
    }
  }, 30_000);

  // A pipe closed at once still lets the server start its background download before it sees EOF.
  test("stdin closed at once exits 0 without waiting for the download", async () => {
    const { cleanup, home, proc, stderr } = coldServer();

    try {
      proc.stdin.end();

      expect(await exitWithin(proc), await stderr).toBe(0);
      expectNoModel(home);
    } finally {
      cleanup();
    }
  }, 30_000);
});

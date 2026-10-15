import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// Raw JSON-RPC responses intentionally remain untyped so assertions check the wire format.
/* oxlint-disable typescript/no-explicit-any */
import type { PipedSubprocess } from "bun";
import type { Schema } from "effect";

import { isModelInstalled } from "../src/providers/kokoro/model.ts";
import { failsAfterStartupCheck, playsFor } from "./helpers/player.ts";
import { cliCommand, waitUntil } from "./helpers/process.ts";
import { useShellFixtures } from "./helpers/shell.ts";
import type { ShellFixture } from "./helpers/shell.ts";

const createFixture = useShellFixtures("voix-mcp-player-test-");

interface JsonRpcRequest {
  readonly id?: number;
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: Schema.JsonObject;
}

/**
 * Drives `voix mcp` over stdio with raw JSON-RPC (newline-delimited), the way an MCP client would.
 * Needs the model in the cache; playback is disabled with VOIX_PLAYER=none.
 */
class StdioClient {
  private proc: PipedSubprocess | undefined;
  private buffer = "";
  private pending = new Map<number, (msg: any) => void>();
  private nextId = 1;
  readonly notifications: any[] = [];
  readonly stderr: string[] = [];

  start(command: string[], env: NodeJS.ProcessEnv = {}) {
    const proc = Bun.spawn(command, {
      env: { ...process.env, VOIX_PLAYER: "none", ...env },
      stderr: "pipe",
      stdin: "pipe",
      stdout: "pipe",
    });

    this.proc = proc;
    void this.pump(proc.stdout);
    void (async () => {
      for await (const chunk of proc.stderr) {
        this.stderr.push(new TextDecoder().decode(chunk));
      }
    })();
  }

  async initialize(env: NodeJS.ProcessEnv = {}) {
    this.start([...cliCommand(), "mcp"], env);

    const response = await this.request("initialize", {
      capabilities: {},
      clientInfo: { name: "voix-test", version: "0" },
      protocolVersion: "2025-06-18",
    });

    this.notify("notifications/initialized");

    return response;
  }

  private async pump(stream: ReadableStream<Uint8Array>) {
    for await (const chunk of stream) {
      this.buffer += new TextDecoder().decode(chunk);
      let nl: number;

      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);

        if (line.length === 0) {
          continue;
        }

        const msg = JSON.parse(line);

        const onResponse =
          msg.id === undefined ? undefined : this.pending.get(msg.id);

        if (onResponse === undefined) {
          this.notifications.push(msg);
        } else {
          onResponse(msg);
          this.pending.delete(msg.id);
        }
      }
    }
  }

  private send(msg: JsonRpcRequest) {
    if (this.proc === undefined) {
      throw new Error("MCP client has not started");
    }

    const w = this.proc.stdin;
    w.write(`${JSON.stringify(msg)}\n`);
    w.flush();
  }

  request(
    method: string,
    params?: Schema.JsonObject,
    timeoutMs = 60_000
  ): Promise<any> {
    const id = this.nextId;
    this.nextId += 1;

    // Bridge incoming JSON-RPC messages and their timeout into a Promise.
    // oxlint-disable-next-line promise/avoid-new
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${method}`)),
        timeoutMs
      );

      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      this.send({ id, jsonrpc: "2.0", method, params: params ?? {} });
    });
  }

  notify(method: string, params?: Schema.JsonObject) {
    this.send({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  /** Close stdin like a client that is done, and return the exit code. */
  async stop() {
    const { proc } = this;

    if (proc === undefined) {
      throw new Error("MCP client has not started");
    }

    proc.stdin.end();
    // Kill a server that ignores EOF so the caller's exit-code assertion fails instead of hanging.
    const timer = setTimeout(() => proc.kill(), 10_000);
    const code = await proc.exited;
    clearTimeout(timer);

    return code;
  }
}

/** Write every frame, close stdin at once, and collect what the server prints before it exits. */
const runOneShot = async (frames: readonly JsonRpcRequest[]) => {
  const proc = Bun.spawn([...cliCommand(), "mcp"], {
    env: { ...process.env, VOIX_PLAYER: "none" },
    stderr: "pipe",
    stdin: new Blob(frames.map((frame) => `${JSON.stringify(frame)}\n`)),
    stdout: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const messages: any[] = stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));

  return { code, messages, stderr };
};

/** Run a fresh MCP server whose PATH holds only the fake players `install` creates. */
const withFakePlayers = async (
  install: (shell: ShellFixture) => void,
  body: (client: StdioClient) => Promise<void>
) => {
  const shell = createFixture();
  install(shell);
  const client = new StdioClient();

  try {
    await client.initialize({ PATH: shell.directory, VOIX_PLAYER: "" });
    await body(client);
  } finally {
    expect(await client.stop()).toBe(0);
  }
};

const speakHello = (client: StdioClient) =>
  client.request("tools/call", {
    arguments: { text: "Hello." },
    name: "speak",
  });

const describeMcp = isModelInstalled() ? describe : describe.skip;

if (!isModelInstalled()) {
  console.warn("mcp tests skipped: model not installed (run `voix setup`)");
}

describeMcp("voix mcp (stdio)", () => {
  const client = new StdioClient();

  beforeAll(async () => {
    const init = await client.initialize();

    expect(init.result.serverInfo.name).toBe("voix");
    expect(init.result.instructions).toContain("speak");
    expect(init.result.instructions).toContain("wait: true");
  });

  afterAll(async () => {
    expect(await client.stop()).toBe(0);
  });

  test("lists speak and stop", async () => {
    const res = await client.request("tools/list");
    const names = res.result.tools.map((t: any) => t.name).toSorted();
    expect(names).toEqual(["speak", "stop"]);
    const speak = res.result.tools.find((t: any) => t.name === "speak");
    expect(
      speak.inputSchema.properties.voice.enum ??
        speak.inputSchema.properties.voice.anyOf
    ).toBeDefined();
    expect(speak.inputSchema.properties.wait.anyOf[0].type).toBe("boolean");
    expect(speak.inputSchema.properties.wait.anyOf[1]).toEqual({
      type: "null",
    });
    expect(speak.inputSchema.required).toEqual(["text"]);
    expect(speak.outputSchema.properties.speaking.type).toBe("boolean");
    expect(speak.outputSchema.properties.status.enum).toEqual([
      "speaking",
      "queued",
      "cancelled",
      "finished",
    ]);
  });

  test("serves the skill resource", async () => {
    const res = await client.request("resources/read", {
      uri: "skill://voix/SKILL.md",
    });

    expect(res.result.contents[0].text).toContain("name: voix");
  });

  test("speak returns speaking, then stop returns stopped", async () => {
    const res = await client.request("tools/call", {
      arguments: {
        text: "Hello from the test suite. This is the second sentence.",
      },
      name: "speak",
    });

    expect(res.result.isError).toBeFalsy();
    expect(res.result.structuredContent).toEqual({
      queued_behind: 0,
      sentences: 2,
      speaking: true,
      status: "speaking",
      voice: "af_heart",
    });

    const stop = await client.request("tools/call", {
      arguments: {},
      name: "stop",
    });

    expect(stop.result.structuredContent.stopped).toBeBoolean();
  }, 90_000);

  test("typed errors come back as tool errors", async () => {
    const res = await client.request("tools/call", {
      arguments: { speed: 9, text: "hi" },
      name: "speak",
    });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("InvalidSpeed");
  });

  test("schema violations are protocol errors", async () => {
    const res = await client.request("tools/call", {
      arguments: { text: 42 },
      name: "speak",
    });

    expect(res.error?.code).toBe(-32_602);
  });

  test("a one-shot client gets every response and a clean exit after EOF", async () => {
    const { code, messages, stderr } = await runOneShot([
      {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "voix-one-shot", version: "0" },
          protocolVersion: "2025-06-18",
        },
      },
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      { id: 2, jsonrpc: "2.0", method: "tools/list", params: {} },
      // Still synthesizing when stdin closes.
      {
        id: 3,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { text: "Hello.", wait: true }, name: "speak" },
      },
    ]);

    expect(code, stderr).toBe(0);

    const byId = new Map(
      messages.filter((msg) => msg.id !== undefined).map((msg) => [msg.id, msg])
    );

    expect([...byId.keys()].toSorted()).toEqual([1, 2, 3]);
    expect(byId.get(1).result.serverInfo.name).toBe("voix");
    expect(byId.get(2).result.tools).toHaveLength(2);
    expect(byId.get(3).result.structuredContent.status).toBe("finished");
  }, 90_000);

  test("wait returns finished and speaking false", async () => {
    const res = await client.request("tools/call", {
      arguments: { text: "Hello.", wait: true },
      name: "speak",
    });

    expect(res.result.isError).toBeFalsy();
    expect(res.result.structuredContent).toEqual({
      queued_behind: 0,
      sentences: 1,
      speaking: false,
      status: "finished",
      voice: "af_heart",
    });
  }, 90_000);
});

describe.skipIf(process.platform !== "linux" || !isModelInstalled())(
  "MCP playback failures",
  () => {
    test("returns a typed tool error when no audio player is installed", async () => {
      await withFakePlayers(
        () => {},
        async (client) => {
          const response = await speakHello(client);

          expect(response.result.isError).toBe(true);
          const error = JSON.parse(response.result.content[0].text);
          expect(error._tag).toBe("PlayerNotFound");
          expect(error.platform).toBe("linux");
        }
      );
    }, 90_000);

    test("returns when the player starts and logs a later playback failure", async () => {
      await withFakePlayers(
        (shell) => shell.command("aplay", failsAfterStartupCheck(7)),
        async (client) => {
          const response = await speakHello(client);

          expect(response.result.isError).toBeFalsy();
          expect(response.result.structuredContent).toEqual({
            queued_behind: 0,
            sentences: 1,
            speaking: true,
            status: "speaking",
            voice: "af_heart",
          });
          await waitUntil(() =>
            client.stderr.join("").includes("aplay exited with code 7")
          );

          expect(client.stderr.join("")).toContain("aplay exited with code 7");
        }
      );
    }, 90_000);

    test("returns PlaybackFailed when every installed player rejects playback", async () => {
      await withFakePlayers(
        (shell) => {
          shell.command("pw-play", "exit 7");
          shell.command("paplay", "exit 8");
          shell.command("aplay", "exit 9");
        },
        async (client) => {
          const response = await speakHello(client);

          expect(response.result.isError).toBe(true);
          const error = JSON.parse(response.result.content[0].text);
          expect(error._tag).toBe("PlaybackFailed");
          expect(error.reason).toContain("pw-play exited with code 7");
          expect(error.reason).toContain("aplay exited with code 9");
        }
      );
    }, 90_000);

    test("wait returns PlaybackFailed when playback fails after startup", async () => {
      await withFakePlayers(
        (shell) => shell.command("aplay", failsAfterStartupCheck(7)),
        async (client) => {
          const response = await client.request("tools/call", {
            arguments: { text: "Hello.", wait: true },
            name: "speak",
          });

          expect(response.result.isError).toBe(true);
          const error = JSON.parse(response.result.content[0].text);
          expect(error._tag).toBe("PlaybackFailed");
          expect(error.reason).toContain("aplay exited with code 7");
        }
      );
    }, 90_000);

    test("wait sends increasing progress while speech plays", async () => {
      await withFakePlayers(
        (shell) => shell.command("aplay", playsFor(5)),
        async (client) => {
          const response = await client.request(
            "tools/call",
            {
              _meta: { progressToken: "wait-1" },
              arguments: {
                text: "Hello from the progress test.",
                wait: true,
              },
              name: "speak",
            },
            30_000
          );

          expect(response.result.isError).toBeFalsy();
          expect(response.result.structuredContent.status).toBe("finished");
          expect(response.result.structuredContent.speaking).toBe(false);

          const progress = client.notifications.filter(
            (note) => note.method === "notifications/progress"
          );

          expect(progress.length).toBeGreaterThanOrEqual(2);

          for (const [index, note] of progress.entries()) {
            expect(note.params).toEqual({
              message: "Waiting for speech to finish",
              progress: index + 1,
              progressToken: "wait-1",
            });
          }
        }
      );
    }, 45_000);
  }
);

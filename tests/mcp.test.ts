import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { isModelInstalled } from "../src/providers/kokoro/model.ts"

/**
 * Drives `voix mcp` over stdio with raw JSON-RPC (newline-delimited), the way an MCP client would.
 * Needs the model in the cache; playback is disabled with VOIX_PLAYER=none.
 */
class StdioClient {
  private proc: ReturnType<typeof Bun.spawn> | undefined
  private buffer = ""
  private pending = new Map<number, (msg: any) => void>()
  private nextId = 1
  readonly notifications: Array<any> = []
  readonly stderr: Array<string> = []

  async start(command: Array<string>) {
    this.proc = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VOIX_PLAYER: "none" }
    })
    void this.pump(this.proc.stdout as unknown as AsyncIterable<Uint8Array>)
    void (async () => {
      for await (const chunk of this.proc!.stderr as unknown as AsyncIterable<Uint8Array>) {
        this.stderr.push(new TextDecoder().decode(chunk))
      }
    })()
  }

  private async pump(stream: AsyncIterable<Uint8Array>) {
    for await (const chunk of stream) {
      this.buffer += new TextDecoder().decode(chunk)
      let nl: number
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (line.length === 0) continue
        const msg = JSON.parse(line)
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg)
          this.pending.delete(msg.id)
        } else {
          this.notifications.push(msg)
        }
      }
    }
  }

  private send(msg: object) {
    const w = this.proc!.stdin as import("bun").FileSink
    w.write(JSON.stringify(msg) + "\n")
    w.flush()
  }

  request(method: string, params?: object, timeoutMs = 60_000): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), timeoutMs)
      this.pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      this.send({ jsonrpc: "2.0", id, method, params: params ?? {} })
    })
  }

  notify(method: string, params?: object) {
    this.send({ jsonrpc: "2.0", method, params: params ?? {} })
  }

  async stop() {
    this.proc?.kill()
    await this.proc?.exited
  }
}

const describeMcp = isModelInstalled() ? describe : describe.skip
if (!isModelInstalled()) console.warn("mcp tests skipped: model not installed (run `voix setup`)")

describeMcp("voix mcp (stdio)", () => {
  const client = new StdioClient()
  const command = process.env.VOIX_BIN ? [process.env.VOIX_BIN, "mcp"] : ["bun", "run", "src/main.ts", "mcp"]

  beforeAll(async () => {
    await client.start(command)
    const init = await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "voix-test", version: "0" }
    })
    expect(init.result.serverInfo.name).toBe("voix")
    expect(init.result.instructions).toContain("speak")
    client.notify("notifications/initialized")
  })

  afterAll(() => client.stop())

  test("lists speak and stop", async () => {
    const res = await client.request("tools/list")
    const names = res.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual(["speak", "stop"])
    const speak = res.result.tools.find((t: any) => t.name === "speak")
    expect(speak.inputSchema.properties.voice.enum ?? speak.inputSchema.properties.voice.anyOf).toBeDefined()
  })

  test("serves the skill resource", async () => {
    const res = await client.request("resources/read", { uri: "skill://voix/SKILL.md" })
    expect(res.result.contents[0].text).toContain("name: voix")
  })

  test("speak returns speaking, then stop returns stopped", async () => {
    const res = await client.request("tools/call", {
      name: "speak",
      arguments: { text: "Hello from the test suite. This is the second sentence." }
    })
    expect(res.result.isError).toBeFalsy()
    expect(res.result.structuredContent.status).toBe("speaking")
    expect(res.result.structuredContent.sentences).toBe(2)
    const stop = await client.request("tools/call", { name: "stop", arguments: {} })
    expect(typeof stop.result.structuredContent.stopped).toBe("boolean")
  }, 90_000)

  test("typed errors come back as tool errors", async () => {
    const res = await client.request("tools/call", { name: "speak", arguments: { text: "hi", speed: 9 } })
    expect(res.result.isError).toBe(true)
    expect(res.result.content[0].text).toContain("InvalidSpeed")
  })

  test("schema violations are protocol errors", async () => {
    const res = await client.request("tools/call", { name: "speak", arguments: { text: 42 } })
    expect(res.error?.code).toBe(-32602)
  })
})

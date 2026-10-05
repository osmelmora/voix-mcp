import { expect, test } from "bun:test";
import path from "node:path";

test("the runtime loader forces telemetry off even when the caller enables it", () => {
  const result = Bun.spawnSync(
    [process.execPath, path.join(import.meta.dir, "fixtures/runtime.ts")],
    {
      // CI also suppresses native telemetry if this regression test ever fails.
      env: { ...process.env, CI: "1", ORT_DISABLE_TELEMETRY: "0" },
      timeout: 10_000,
    }
  );

  expect(result.exitCode).toBe(0);
  expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
    telemetryDisabled: "1",
    version: expect.any(String),
  });
});

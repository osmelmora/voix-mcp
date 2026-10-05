import { afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Create an isolated set of shell commands; callers outside a test hook can clean it up explicitly. */
export const createShellFixture = (prefix: string) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));

  const command = (name: string, body: string, executable = true) => {
    const file = path.join(directory, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, executable ? 0o755 : 0o644);
  };

  return {
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
    command,
    directory,
  };
};

/** Register one cleanup hook per test file and create fixtures owned by that hook. */
export const useShellFixtures = (prefix: string) => {
  const fixtures: ReturnType<typeof createShellFixture>[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) {
      fixture.cleanup();
    }
  });

  return () => {
    const fixture = createShellFixture(prefix);
    fixtures.push(fixture);

    return fixture;
  };
};

import { afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** An isolated directory of shell commands, removed by the test hook that created it. */
const createShellFixture = (prefix: string) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));

  const command = (
    name: string,
    body: string,
    options: { readonly executable?: boolean } = {}
  ) => {
    const file = path.join(directory, name);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, options.executable === false ? 0o644 : 0o755);
  };

  return {
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
    command,
    directory,
  };
};

export type ShellFixture = ReturnType<typeof createShellFixture>;

/** Register one cleanup hook per test file and create fixtures owned by that hook. */
export const useShellFixtures = (prefix: string) => {
  const fixtures: ShellFixture[] = [];

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

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { useShellFixtures } from "./helpers/shell.ts";

const createFixture = useShellFixtures("voix-install-test-");

const install = (platform: string, arch: string, libc = "glibc") => {
  const shell = createFixture();
  const { directory } = shell;

  shell.command(
    "getconf",
    'if [ "$VOIX_TEST_LIBC" = glibc ]; then echo "glibc 2.39"; else exit 1; fi'
  );
  shell.command(
    "uname",
    'case "$1" in\n-s) echo "$VOIX_TEST_OS" ;;\n-m) echo "$VOIX_TEST_ARCH" ;;\nesac'
  );
  shell.command(
    "curl",
    'printf "%s\\n" "$2" > "$VOIX_TEST_URL"\nprintf "#!/bin/sh\\nexit 0\\n" > "$4"'
  );

  const proc = Bun.spawnSync(
    ["/bin/sh", path.join(import.meta.dir, "../scripts/install.sh")],
    {
      env: {
        ...process.env,
        PATH: `${directory}:/usr/bin:/bin`,
        VOIX_INSTALL_DIR: path.join(directory, "installed"),
        VOIX_REPO: "osmelmora/voix-mcp",
        VOIX_TEST_ARCH: arch,
        VOIX_TEST_LIBC: libc,
        VOIX_TEST_OS: platform,
        VOIX_TEST_URL: path.join(directory, "url"),
        VOIX_VERSION: "latest",
      },
    }
  );

  return { directory, proc };
};

describe("installer", () => {
  test.each([
    ["Darwin", "arm64", "voix-darwin-arm64"],
    ["Linux", "x86_64", "voix-linux-x64"],
  ])("installs the correct asset for %s %s", (platform, arch, asset) => {
    const { directory, proc } = install(platform, arch);
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(path.join(directory, "url"), "utf-8").trim()).toBe(
      `https://github.com/osmelmora/voix-mcp/releases/latest/download/${asset}`
    );
    expect(
      Bun.spawnSync([path.join(directory, "installed/voix")]).exitCode
    ).toBe(0);
  });

  test("rejects unsupported architectures before downloading", () => {
    const { directory, proc } = install("Linux", "aarch64");
    expect(proc.exitCode).toBe(1);
    expect(new TextDecoder().decode(proc.stderr)).toContain(
      "no prebuilt binary for linux-aarch64"
    );
    expect(existsSync(path.join(directory, "url"))).toBe(false);
  });

  test("rejects musl hosts before downloading the glibc binary", () => {
    const { directory, proc } = install("Linux", "x86_64", "musl");
    expect(proc.exitCode).toBe(1);
    expect(new TextDecoder().decode(proc.stderr)).toContain("requires glibc");
    expect(existsSync(path.join(directory, "url"))).toBe(false);
  });
});

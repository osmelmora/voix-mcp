import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import type { ShellFixture } from "./shell.ts";

const SCRIPT = path.join(import.meta.dir, "../../scripts/release.ts");

const COG_CONFIG = path.join(import.meta.dir, "../../cog.toml");

/**
 * The test environment without git's repository variables, which a hook running these tests
 * exports, and without the user's or system git config.
 */
export const hermeticEnv = () => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))
  ),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
});

export const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: hermeticEnv() });

  if (!result.success) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }

  return result.stdout.toString().trim();
};

/**
 * Logs each call, then answers `gh api` from GH_TEST_RELEASES or GH_TEST_RUNS ("fail"
 * fails the call). Unset answers and other calls fail, so no test reaches GitHub.
 */
const FAKE_GH = String.raw`printf '%s\t' "$@" >> "$GH_TEST_LOG"
echo >> "$GH_TEST_LOG"
[ "$GH_TOKEN" = test-token ] || { echo "gh: no workflow token" >&2; exit 4; }
case "$3" in
*/releases\?per_page=100) variable=GH_TEST_RELEASES ;;
*/actions/workflows/ci.yml/runs\?head_sha=*) variable=GH_TEST_RUNS ;;
*) echo "unexpected gh call: $*" >&2; exit 1 ;;
esac
response=$(printenv "$variable") || { echo "unexpected gh call: $*" >&2; exit 1; }
[ "$response" = fail ] && { echo "gh: HTTP 502: Bad Gateway" >&2; exit 1; }
printf '%s' "$response"`;

const read = (file: string) => readFileSync(file, "utf-8");

/** Installs a git hook in a repository's default hooks directory. */
export const hook = (gitDirectory: string, name: string, body: string) => {
  const file = path.join(gitDirectory, "hooks", name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
};

/**
 * A project on a local bare origin: v0.1.0, then a fix on main. `checkout` clones origin the
 * way actions/checkout leaves a runner, and `run` starts the release script there with a
 * fake `gh` first on PATH.
 */
export const createProject = (shell: ShellFixture) => {
  const root = shell.directory;
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");

  const files = {
    ghLog: path.join(root, "gh.log"),
    output: path.join(root, "github-output"),
    summary: path.join(root, "github-summary"),
  };

  shell.command("gh", FAKE_GH);
  writeFileSync(files.ghLog, "");
  writeFileSync(files.output, "previous=kept\n");
  writeFileSync(files.summary, "");

  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(root, "init", "--quiet", "--initial-branch=main", work);
  git(work, "config", "user.name", "Developer");
  git(work, "config", "user.email", "developer@example.com");
  git(work, "remote", "add", "origin", origin);
  mkdirSync(path.join(work, "docs"));
  writeFileSync(path.join(work, "docs/README.md"), "# Fixture\n");
  writeFileSync(
    path.join(work, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, version: "0.1.0" })}\n`
  );
  copyFileSync(COG_CONFIG, path.join(work, "cog.toml"));
  git(work, "add", "--all");
  git(work, "commit", "--quiet", "--message", "feat: start");
  git(work, "tag", "v0.1.0");

  /** Commits on the work clone's main and returns the commit. */
  const commit = (message: string) => {
    git(work, "commit", "--quiet", "--allow-empty", "--message", message);

    return git(work, "rev-parse", "HEAD");
  };

  const sha = commit("fix: repair");
  git(work, "push", "--quiet", "origin", "main", "--tags");

  const checkout = (name: string, at = sha) => {
    const directory = path.join(root, name);
    git(root, "clone", "--quiet", origin, directory);
    git(directory, "reset", "--quiet", "--hard", at);

    return directory;
  };

  const run = (
    command: string,
    cwd: string,
    env: Readonly<Record<string, string>> = {}
  ) => {
    const proc = Bun.spawnSync([process.execPath, SCRIPT, command], {
      cwd,
      env: {
        ...hermeticEnv(),
        BUMP: "",
        DRY_RUN: "",
        GH_TEST_LOG: files.ghLog,
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: files.output,
        GITHUB_REF: "refs/heads/main",
        GITHUB_REF_NAME: "main",
        GITHUB_REPOSITORY: "owner/voix",
        GITHUB_RUN_ID: "100",
        GITHUB_SHA: sha,
        GITHUB_STEP_SUMMARY: files.summary,
        PATH: `${root}:${process.env.PATH}`,
        TAG: "v0.1.1",
        VERSION: "",
        ...env,
      },
      timeout: 20_000,
    });

    return {
      exitCode: proc.exitCode,
      ghCalls: read(files.ghLog)
        .split("\n")
        .flatMap((line) =>
          line === "" ? [] : [line.split("\t").slice(0, -1)]
        ),
      outputs: read(files.output),
      stdout: proc.stdout.toString(),
      summary: read(files.summary),
    };
  };

  return { checkout, commit, origin, run, sha, work };
};

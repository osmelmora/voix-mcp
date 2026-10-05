// Usage: bun run scripts/release.ts plan|release
//
// The plan and release jobs in .github/workflows/ci.yml. This file runs git, cog, and gh
// and writes the step's outputs; the decisions are in release-core.ts. Bun and Node
// built-ins only, so those jobs need no `bun install`.
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  afterRejectedPush,
  annotation,
  bumpRequest,
  exactVersionFailure,
  findSuccessor,
  isLatest,
  noSuccessorMessage,
  planFromDryRun,
  publishedTags,
  releasedIn,
  releaseStep,
  RELEASES_JQ,
  remoteRef,
  RUNS_JQ,
  tagCommit,
  tagFailure,
  tagVersion,
} from "./release-core.ts";
import type { ReleaseState } from "./release-core.ts";

interface Completed {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs a command to completion with the inherited environment, copying its stderr to the
 * log. A command that cannot start, or that a signal kills, throws; the exit code is the
 * caller's to check.
 */
const attempt = (command: readonly string[], cwd: string): Completed => {
  const result = Bun.spawnSync([...command], {
    cwd,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });

  const stderr = result.stderr.toString();
  process.stderr.write(stderr);

  if (result.signalCode !== undefined) {
    throw new Error(`${command.join(" ")} was killed by ${result.signalCode}`);
  }

  return {
    exitCode: result.exitCode,
    stderr,
    stdout: result.stdout.toString(),
  };
};

/** Runs a command and returns its stdout. Any failure fails the step. */
const run = (command: readonly string[], cwd: string) => {
  const result = attempt(command, cwd);

  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} exited ${result.exitCode}: ${result.stderr.trim()}`
    );
  }

  return result.stdout;
};

const variable = (name: string) => process.env[name] ?? "";

const required = (name: string) => {
  const value = variable(name);

  if (value === "") {
    throw new Error(`${name} is not set`);
  }

  return value;
};

/** Appends, never overwrites: GitHub reads each file once the step ends. */
const append = (
  file: "GITHUB_OUTPUT" | "GITHUB_STEP_SUMMARY",
  lines: readonly string[]
) => appendFileSync(required(file), lines.map((line) => `${line}\n`).join(""));

const notice = (message: string) => console.log(annotation("notice", message));

const repositoryRoot = () =>
  run(["git", "rev-parse", "--show-toplevel"], process.cwd()).trim();

const plan = () => {
  const request = bumpRequest({
    bump: variable("BUMP"),
    ref: variable("GITHUB_REF"),
    refName: variable("GITHUB_REF_NAME"),
    version: variable("VERSION"),
  });

  if (request.kind === "fail") {
    throw new Error(request.message);
  }

  const root = repositoryRoot();
  const cog = (...args: string[]) => run(["cog", ...args], root);

  if (request.exact !== undefined) {
    const failure = exactVersionFailure(request.exact, cog("get-version"));

    if (failure !== undefined) {
      throw new Error(failure.message);
    }
  }

  const next = planFromDryRun(
    cog("bump", "--dry-run", ...request.args),
    variable("DRY_RUN") === "true"
  );

  if (next.kind === "fail") {
    throw new Error(next.message);
  }

  if (next.kind === "nothing") {
    append("GITHUB_STEP_SUMMARY", ["Nothing to release."]);

    return;
  }

  append("GITHUB_OUTPUT", [
    `tag=${next.tag}`,
    `version=${next.version}`,
    ...(next.publish ? ["publish=true"] : []),
  ]);
  append("GITHUB_STEP_SUMMARY", [
    next.publish
      ? `Releasing ${next.tag} if both platforms pass.`
      : `Dry run: would release ${next.tag}.`,
  ]);
};

interface Release {
  readonly root: string;
  readonly repository: string;
  readonly runId: string;
  readonly sha: string;
  readonly tag: string;
}

const git = (release: Release, ...args: string[]) =>
  run(["git", ...args], release.root);

const gh = (release: Release, endpoint: string, jq: string) =>
  run(["gh", "api", "--paginate", endpoint, "--jq", jq], release.root);

const published = (release: Release) =>
  publishedTags(
    gh(
      release,
      `repos/${release.repository}/releases?per_page=100`,
      RELEASES_JQ
    )
  );

/** origin's main and tag, and the local tag, read afresh. */
const observe = (release: Release): ReleaseState => {
  const tagRef = `refs/tags/${release.tag}`;
  const remote = git(release, "ls-remote", "origin", "refs/heads/main", tagRef);
  const main = remoteRef(remote, "refs/heads/main");

  if (main === undefined) {
    throw new Error("origin has no main branch");
  }

  const local = git(
    release,
    "for-each-ref",
    "--format=%(objectname)",
    tagRef
  ).trim();

  return {
    localTag:
      local === ""
        ? undefined
        : tagCommit(local, git(release, "log", "-1", "--format=%P%n%s", local)),
    main,
    remoteTag: remoteRef(remote, tagRef),
    sha: release.sha,
    tag: release.tag,
  };
};

/** Commits and tags the bump on the tested commit, then pushes both or neither. */
const bumpAndPush = (release: Release) => {
  git(release, "config", "user.name", "github-actions[bot]");
  git(
    release,
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com"
  );
  console.log(
    run(["cog", "bump", "--version", release.tag.slice(1)], release.root)
  );

  // Atomic, so a rejected main cannot leave the tag behind. A failed push is an answer:
  // read origin again to tell a moved main from a lost response or a real rejection.
  const push = attempt(
    [
      "git",
      "push",
      "--atomic",
      "origin",
      "HEAD:refs/heads/main",
      `refs/tags/${release.tag}`,
    ],
    release.root
  );

  return push.exitCode === 0
    ? ({ kind: "pushed" } as const)
    : afterRejectedPush(observe(release));
};

/** main moved past the tested commit: skip when a release or a newer run covers it. */
const mainMoved = (release: Release) => {
  const releases = published(release);

  const releasedTag = releasedIn(
    releases,
    git(release, "tag", "--contains", release.sha)
  );

  if (releasedTag !== undefined) {
    notice(`${release.sha} was already released in ${releasedTag}.`);

    return;
  }

  const successor = findSuccessor(
    {
      main: () => observe(release).main,
      runs: (sha) =>
        gh(
          release,
          `repos/${release.repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`,
          RUNS_JQ
        ),
      sleep: Bun.sleepSync,
    },
    release.runId
  );

  // The successor waits in the same concurrency group, so its outcome is unknowable here.
  // It plans everything since the last tag, this commit included; if it fails or is
  // cancelled, re-running it (or any later green run on main) still releases this commit.
  if (successor.kind === "found") {
    notice(
      `main moved to ${successor.main}; ${successor.run.url} releases it. If that run fails or is cancelled, re-run it.`
    );

    return;
  }

  git(release, "fetch", "--quiet", "--no-tags", "origin", successor.main);

  const subject = git(
    release,
    "log",
    "-1",
    "--format=%s",
    successor.main
  ).trim();

  throw new Error(noSuccessorMessage(successor.main, subject, releases));
};

/** Checks origin's tag, writes the notes, and hands the release to the publisher step. */
const publish = (release: Release) => {
  const failure = tagFailure(observe(release));

  if (failure !== undefined) {
    throw new Error(failure.message);
  }

  // cog changelog --at only gives the right notes with HEAD at the tag.
  git(release, "checkout", "--quiet", "--detach", `refs/tags/${release.tag}`);
  writeFileSync(
    path.join(release.root, "RELEASE_NOTES.md"),
    run(["cog", "changelog", "--at", release.tag], release.root)
  );

  const latest = isLatest(release.tag, published(release));
  append("GITHUB_OUTPUT", ["publish=true", `latest=${latest}`]);
};

const release = () => {
  const tag = required("TAG");

  if (tagVersion(tag) === undefined) {
    throw new Error(`TAG must be a stable vX.Y.Z, not '${tag}'`);
  }

  const context: Release = {
    repository: required("GITHUB_REPOSITORY"),
    root: repositoryRoot(),
    runId: required("GITHUB_RUN_ID"),
    sha: required("GITHUB_SHA"),
    tag,
  };

  const step = releaseStep(observe(context));
  const ready = step.kind === "bump" ? bumpAndPush(context) : step;

  if (ready.kind === "fail") {
    throw new Error(ready.message);
  }

  if (ready.kind === "moved") {
    mainMoved(context);

    return;
  }

  // Pushed now, or by an earlier attempt.
  publish(context);
};

const commands = new Map([
  ["plan", plan],
  ["release", release],
]);

try {
  const command = commands.get(process.argv.at(2) ?? "");

  if (command === undefined) {
    throw new Error("usage: bun run scripts/release.ts plan|release");
  }

  command();
} catch (error) {
  console.log(
    annotation("error", error instanceof Error ? error.message : String(error))
  );
  process.exitCode = 1;
}

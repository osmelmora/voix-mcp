import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  afterRejectedPush,
  annotation,
  bumpRequest,
  exactVersionFailure,
  findSuccessor,
  isLatest,
  isSuccessor,
  noSuccessorMessage,
  planFromDryRun,
  publishedTags,
  RELEASES_JQ,
  releasedIn,
  releaseStep,
  RETRY_DELAYS,
  RUNS_JQ,
  tagFailure,
} from "../scripts/release-core.ts";
import type {
  Plan,
  PlanRequest,
  ReleaseState,
  ReleaseStep,
  WorkflowRun,
} from "../scripts/release-core.ts";
import { createProject, git, hook } from "./helpers/release.ts";
import { useShellFixtures } from "./helpers/shell.ts";

const createFixture = useShellFixtures("voix-release-test-");

const NO_BUMP =
  "No conventional commits for your repository that required a bump. Changelogs will be updated on the next bump.\nPre-Hooks and Post-Hooks have been skipped.\n";

const request = (inputs: Partial<PlanRequest>): PlanRequest => ({
  bump: "",
  ref: "refs/heads/main",
  refName: "main",
  version: "",
  ...inputs,
});

describe("release planning", () => {
  test.each([
    ["a push bumps automatically", {}, ["--auto"]],
    ["auto", { bump: "auto" }, ["--auto"]],
    ["an explicit patch", { bump: "patch" }, ["--patch"]],
    ["an explicit minor", { bump: "minor" }, ["--minor"]],
    ["an explicit major", { bump: "major" }, ["--major"]],
    [
      "an exact version over the bump",
      { bump: "major", version: "0.3.0" },
      ["--version", "0.3.0"],
    ],
  ])("%s", (_, inputs, args) => {
    expect(bumpRequest(request(inputs))).toMatchObject({ args, kind: "bump" });
  });

  test.each([
    ["a prerelease", "0.3.0-beta.1"],
    ["build metadata", "0.3.0+build.1"],
    ["a v prefix", "v0.3.0"],
    ["a leading zero", "0.03.0"],
    ["shell injection", "0.3.0; touch pwned"],
    ["command substitution", "$(touch pwned)"],
    ["a second line", "0.3.0\n::notice::injected"],
  ])("rejects %s as an exact version", (_, version) => {
    expect(bumpRequest(request({ version }))).toEqual({
      kind: "fail",
      message: `version must be a stable X.Y.Z, not '${version}'`,
    });
  });

  test("rejects an unknown bump and runs from other refs", () => {
    expect(bumpRequest(request({ bump: "huge" }))).toMatchObject({
      kind: "fail",
    });
    expect(
      bumpRequest(request({ ref: "refs/heads/feature", refName: "feature" }))
    ).toEqual({ kind: "fail", message: "Releases run from main, not feature" });
  });

  test.each([
    ["0.3.0", "0.2.0\n"],
    ["0.10.0", "0.2.0"],
    ["1.0.0", "0.99.99"],
  ])("accepts exact version %s above %j", (version, current) => {
    expect(exactVersionFailure(version, current)).toBeUndefined();
  });

  test.each([
    ["an equal version", "0.2.0", "0.2.0\n"],
    ["a lower version", "0.1.9", "0.2.0"],
    ["a numerically lower version", "0.9.0", "0.10.0"],
    [
      "the release of a current prerelease, as sort -V did",
      "0.3.0",
      "0.3.0-beta.1",
    ],
  ])("rejects %s", (_, version, current) => {
    expect(exactVersionFailure(version, current)).toEqual({
      kind: "fail",
      message: `version ${version} is not greater than the current ${current.trim()}`,
    });
  });

  test("fails on a current version it cannot read", () => {
    expect(exactVersionFailure("1.0.0", "Current version:")).toMatchObject({
      kind: "fail",
    });
  });

  test.each([
    [
      "a due bump publishes",
      "v0.2.1\n",
      false,
      { kind: "release", publish: true, tag: "v0.2.1", version: "0.2.1" },
    ],
    [
      "a dry run stops before publishing",
      "v0.2.1\n",
      true,
      { kind: "release", publish: false, tag: "v0.2.1", version: "0.2.1" },
    ],
    ["no bump is nothing to release", NO_BUMP, false, { kind: "nothing" }],
    [
      "other output fails",
      "v0.2.1\nwarning: extra",
      false,
      {
        kind: "fail",
        message:
          "Unexpected output from cog bump --dry-run: v0.2.1\nwarning: extra",
      },
    ],
  ] satisfies [string, string, boolean, Plan][])(
    "%s",
    (_, output, dryRun, plan) => {
      expect(planFromDryRun(output, dryRun)).toEqual(plan);
    }
  );
});

const BUMP = {
  parent: "S",
  ref: "C",
  subject: "chore(version): v0.2.1",
};

const state = (observed: Partial<ReleaseState>): ReleaseState => ({
  localTag: undefined,
  main: "S",
  remoteTag: undefined,
  sha: "S",
  tag: "v0.2.1",
  ...observed,
});

describe("release state", () => {
  test.each([
    ["bumps a tested commit that is still main", {}, { kind: "bump" }],
    [
      "resumes its own pushed bump with main at the bump",
      { localTag: BUMP, main: "C", remoteTag: "C" },
      { kind: "resume" },
    ],
    [
      "resumes its own pushed bump with main beyond it",
      { localTag: BUMP, main: "D", remoteTag: "C" },
      { kind: "resume" },
    ],
    [
      "fails on a foreign tag while main is unmoved",
      { localTag: { ...BUMP, parent: "R" }, remoteTag: "C" },
      {
        kind: "fail",
        message: "v0.2.1 already exists and is not the bump of S",
      },
    ],
    [
      "fails on a tag on its child that is not the bump",
      { localTag: { ...BUMP, subject: "fix: other" }, remoteTag: "C" },
      {
        kind: "fail",
        message: "v0.2.1 already exists and is not the bump of S",
      },
    ],
    [
      "fails on a remote tag missing locally while main is unmoved",
      { remoteTag: "C" },
      {
        kind: "fail",
        message: "v0.2.1 already exists and is not the bump of S",
      },
    ],
    [
      "checks a newer run when a foreign tag exists and main moved",
      { localTag: { ...BUMP, parent: "R" }, main: "T", remoteTag: "C" },
      { kind: "moved" },
    ],
    ["checks a newer run when main moved", { main: "T" }, { kind: "moved" }],
  ] satisfies [string, Partial<ReleaseState>, ReleaseStep][])(
    "%s",
    (_, observed, step) => {
      expect(releaseStep(state(observed))).toEqual(step);
    }
  );

  test.each([
    [
      "fails when origin rejected the push and main has not moved",
      { localTag: BUMP },
      {
        kind: "fail",
        message: "origin rejected the push of v0.2.1, and main has not moved",
      },
    ],
    [
      "checks a newer run when main moved before the push",
      { localTag: BUMP, main: "T" },
      { kind: "moved" },
    ],
    [
      "resumes when origin took the push but the response was lost",
      { localTag: BUMP, main: "C", remoteTag: "C" },
      { kind: "resume" },
    ],
  ] satisfies [string, Partial<ReleaseState>, ReleaseStep][])(
    "after a rejected push, %s",
    (_, observed, step) => {
      expect(afterRejectedPush(state(observed))).toEqual(step);
    }
  );

  test.each([
    [
      "origin's tag is the local bump",
      { localTag: BUMP, main: "C", remoteTag: "C" },
      true,
    ],
    [
      "origin's tag moved before publishing",
      { localTag: BUMP, main: "C", remoteTag: "X" },
      false,
    ],
    ["origin has no tag", { localTag: BUMP, main: "C" }, false],
    [
      "the local tag is not on the tested commit",
      { localTag: { ...BUMP, parent: "R" }, main: "C", remoteTag: "C" },
      false,
    ],
  ])("publishes only when %s", (_, observed, publishable) => {
    expect(tagFailure(state(observed))).toEqual(
      publishable
        ? undefined
        : { kind: "fail", message: "origin's v0.2.1 is not the bump of S" }
    );
  });
});

const releases = (...rows: string[]) => rows.map((row) => `${row}\n`).join("");

describe("latest release", () => {
  test.each([
    [
      "L1: only an older release is published",
      releases("v0.2.0\tfalse\tfalse"),
      true,
    ],
    [
      "L2: a newer release is published",
      releases("v0.2.2\tfalse\tfalse"),
      false,
    ],
    [
      "L3: this release is already published",
      releases("v0.2.1\tfalse\tfalse", "v0.2.0\tfalse\tfalse"),
      true,
    ],
    [
      "L4: only a newer prerelease or draft",
      releases(
        "v0.3.0-beta.1\ttrue\tfalse",
        "v0.3.0\tfalse\ttrue",
        "v0.4.0\ttrue\tfalse"
      ),
      true,
    ],
    ["L5: nothing is published", "", true],
    [
      "L7: the newest release is on the eleventh page",
      releases(
        ...Array.from(
          { length: 1000 },
          (_, minor) => `v0.1.${minor}\tfalse\tfalse`
        ),
        "v0.2.2\tfalse\tfalse"
      ),
      false,
    ],
    ["versions compare numerically", releases("v0.10.0\tfalse\tfalse"), false],
  ])("%s", (_, listing, latest) => {
    expect(isLatest("v0.2.1", publishedTags(listing))).toBe(latest);
  });

  test("fails on a listing it cannot read", () => {
    expect(() => publishedTags("v0.2.0\tfalse\n")).toThrow(
      "Unexpected line from gh api: v0.2.0\tfalse"
    );
    expect(() => publishedTags("v0.2.0\tnull\tfalse\n")).toThrow(
      "Unexpected flag from gh api: null"
    );
  });
});

const run = (fields: Partial<WorkflowRun>): WorkflowRun => ({
  branch: "main",
  conclusion: "",
  event: "push",
  id: "200",
  sha: "T",
  status: "in_progress",
  url: "https://github.com/owner/voix/actions/runs/200",
  ...fields,
});

const runLine = (fields: Partial<WorkflowRun>) => {
  const { branch, conclusion, event, id, sha, status, url } = run(fields);

  return `${[id, event, branch, sha, status, conclusion, url].join("\t")}\n`;
};

/** A lookup that answers in turn from the lists, recording the heads it queried and the sleeps. */
const scripted = (mains: string[], answers: string[]) => {
  const queried: string[] = [];
  const slept: number[] = [];

  return {
    lookup: {
      main: () => mains.shift() ?? "T",
      runs: (sha: string) => {
        queried.push(sha);

        return answers.shift() ?? "";
      },
      sleep: (milliseconds: number) => {
        slept.push(milliseconds);
      },
    },
    queried,
    slept,
  };
};

describe("main moved", () => {
  test.each([
    [
      "the first published release that contains it",
      "v0.2.1\nv0.2.2\nv0.3.0\n",
      "v0.2.1",
    ],
    ["not when only an unpublished tag contains it", "v0.3.0\n", undefined],
    ["not when no tag contains it", "", undefined],
  ])("already released: %s", (_, containing, tag) => {
    expect(releasedIn(["v0.2.0", "v0.2.2", "v0.2.1"], containing)).toBe(tag);
  });

  test.each([
    ["a queued push run", { status: "queued" }, true],
    ["an in-progress push run", { status: "in_progress" }, true],
    ["a waiting push run", { status: "waiting" }, true],
    ["a pending push run", { status: "pending" }, true],
    ["a requested push run", { status: "requested" }, true],
    ["a passed push run", { conclusion: "success", status: "completed" }, true],
    [
      "a failed push run",
      { conclusion: "failure", status: "completed" },
      false,
    ],
    [
      "a cancelled push run",
      { conclusion: "cancelled", status: "completed" },
      false,
    ],
    [
      "a skipped push run",
      { conclusion: "skipped", status: "completed" },
      false,
    ],
    [
      "a timed-out push run",
      { conclusion: "timed_out", status: "completed" },
      false,
    ],
    ["a run in an unknown state", { status: "stale" }, false],
    [
      "a dispatch, which may be a dry run",
      { event: "workflow_dispatch" },
      false,
    ],
    ["this run", { id: "100" }, false],
    ["a run on another branch", { branch: "feature" }, false],
    ["a run for another commit", { sha: "U" }, false],
  ])("counts %s as a successor: %p", (_, fields, successor) => {
    expect(isSuccessor(run(fields), "T", "100")).toBe(successor);
  });

  test("hands over to a successor found at once", () => {
    const { lookup, queried, slept } = scripted(["T"], [runLine({})]);
    expect(findSuccessor(lookup, "100")).toEqual({
      kind: "found",
      main: "T",
      run: run({}),
    });
    expect(queried).toEqual(["T"]);
    expect(slept).toEqual([]);
  });

  test("retries while GitHub has not listed the run yet", () => {
    const { lookup, slept } = scripted(
      ["T", "T"],
      ["", runLine({ status: "queued" })]
    );

    expect(findSuccessor(lookup, "100")).toMatchObject({
      kind: "found",
      main: "T",
    });
    expect(slept).toEqual([5000]);
  });

  test("follows main when it moves again between attempts", () => {
    const { lookup, queried } = scripted(
      ["T", "U"],
      ["", runLine({ sha: "U" })]
    );

    expect(findSuccessor(lookup, "100")).toMatchObject({
      kind: "found",
      main: "U",
    });
    expect(queried).toEqual(["T", "U"]);
  });

  test("gives up after about a minute without a successor", () => {
    const { lookup, queried, slept } = scripted(
      [],
      ["", runLine({ event: "workflow_dispatch" }), "", "", ""]
    );

    expect(findSuccessor(lookup, "100")).toEqual({ kind: "none", main: "T" });
    expect(queried).toHaveLength(RETRY_DELAYS.length + 1);
    expect(slept).toEqual([...RETRY_DELAYS]);
    expect(slept.reduce((total, delay) => total + delay, 0)).toBe(60_000);
  });

  test("fails at once when the lookup fails or answers garbage", () => {
    const { lookup, slept } = scripted(["T"], []);

    const failing = {
      ...lookup,
      runs: () => {
        throw new Error("gh api exited 1: HTTP 502");
      },
    };

    expect(() => findSuccessor(failing, "100")).toThrow("HTTP 502");
    expect(() =>
      findSuccessor(
        { ...lookup, runs: () => "<html>rate limited</html>\n" },
        "100"
      )
    ).toThrow("Unexpected line from gh api");
    expect(slept).toEqual([]);
  });

  test.each([
    [
      "an unpublished bump points at its release job",
      "chore(version): v0.2.2",
      "main moved to C, the v0.2.2 bump, which is not published yet. Re-run the release job of the run that pushed v0.2.2.",
    ],
    [
      "a published bump points at the workflow",
      "chore(version): v0.2.1",
      "main moved to C, which has no ci run that can release it. Run the ci workflow on main to release.",
    ],
    [
      "another commit points at the workflow",
      "fix: pushed with [skip ci]",
      "main moved to C, which has no ci run that can release it. Run the ci workflow on main to release.",
    ],
  ])("without a successor, %s", (_, subject, message) => {
    expect(noSuccessorMessage("C", subject, ["v0.2.0", "v0.2.1"])).toBe(
      message
    );
  });

  test("escapes annotation data so a message stays one annotation", () => {
    expect(annotation("error", "50% done\r\nnext")).toBe(
      "::error::50%25 done%0D%0Anext"
    );
  });
});

const RELEASES_CALL = [
  "api",
  "--paginate",
  "repos/owner/voix/releases?per_page=100",
  "--jq",
  RELEASES_JQ,
];

const runsCall = (sha: string) => [
  "api",
  "--paginate",
  `repos/owner/voix/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`,
  "--jq",
  RUNS_JQ,
];

const PUBLISHED = "v0.1.0\tfalse\tfalse\n";

// Real git, cog, and Bun processes; slower runners need more than the 5 s default.
const INTEGRATION = { timeout: 30_000 };

describe("release script", () => {
  test(
    "plans the next version and appends the outputs",
    () => {
      const project = createProject(createFixture());
      const result = project.run("plan", project.work);
      expect(result.exitCode).toBe(0);
      expect(result.outputs).toBe(
        "previous=kept\ntag=v0.1.1\nversion=0.1.1\npublish=true\n"
      );
      expect(result.summary).toBe("Releasing v0.1.1 if both platforms pass.\n");
    },
    INTEGRATION
  );

  test(
    "plans a dry run without publish, and an exact version",
    () => {
      const project = createProject(createFixture());

      const result = project.run("plan", project.work, {
        DRY_RUN: "true",
        VERSION: "0.3.0",
      });

      expect(result.exitCode).toBe(0);
      expect(result.outputs).toBe("previous=kept\ntag=v0.3.0\nversion=0.3.0\n");
      expect(result.summary).toBe("Dry run: would release v0.3.0.\n");
    },
    INTEGRATION
  );

  test(
    "plans nothing after non-bumping commits",
    () => {
      const project = createProject(createFixture());
      git(project.work, "reset", "--quiet", "--hard", "v0.1.0");
      project.commit("docs: explain");
      project.commit("ci: tune");
      const result = project.run("plan", project.work);
      expect(result.exitCode).toBe(0);
      expect(result.outputs).toBe("previous=kept\n");
      expect(result.summary).toBe("Nothing to release.\n");
    },
    INTEGRATION
  );

  test(
    "fails an exact version that is not above cog's current version",
    () => {
      const project = createProject(createFixture());
      const result = project.run("plan", project.work, { VERSION: "0.1.0" });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(
        "::error::version 0.1.0 is not greater than the current 0.1.0"
      );
      expect(result.outputs).toBe("previous=kept\n");
    },
    INTEGRATION
  );

  test(
    "fails with an annotation when a tool is missing",
    () => {
      const shell = createFixture();
      const project = createProject(shell);

      const result = project.run("plan", project.work, {
        PATH: shell.directory,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toStartWith("::error::");
      expect(result.stdout).toContain("Executable not found");
    },
    INTEGRATION
  );

  test(
    "bumps, pushes, and prepares the release",
    () => {
      const project = createProject(createFixture());
      const ci = project.checkout("ci");

      const result = project.run("release", ci, {
        GH_TEST_RELEASES: PUBLISHED,
      });

      expect(result.exitCode).toBe(0);
      expect(result.outputs).toBe("previous=kept\npublish=true\nlatest=true\n");
      expect(result.ghCalls).toEqual([RELEASES_CALL]);

      const bump = git(project.origin, "rev-parse", "main");
      expect(git(project.origin, "rev-parse", "v0.1.1")).toBe(bump);
      expect(git(project.origin, "log", "-1", "--format=%P %an %s", bump)).toBe(
        `${project.sha} github-actions[bot] chore(version): v0.1.1`
      );
      expect(
        readFileSync(path.join(ci, "RELEASE_NOTES.md"), "utf-8")
      ).toStartWith("## v0.1.1");
    },
    INTEGRATION
  );

  test(
    "L6, then a re-run from another directory resumes without bumping again",
    () => {
      const project = createProject(createFixture());

      const failed = project.run("release", project.checkout("ci"), {
        GH_TEST_RELEASES: "fail",
      });

      expect(failed.exitCode).toBe(1);
      expect(failed.stdout).toContain("HTTP 502");
      expect(failed.outputs).toBe("previous=kept\n");
      const bump = git(project.origin, "rev-parse", "main");

      const rerun = project.checkout("rerun");

      const result = project.run("release", path.join(rerun, "docs"), {
        GH_TEST_RELEASES: PUBLISHED,
      });

      expect(result.exitCode).toBe(0);
      expect(result.outputs).toBe("previous=kept\npublish=true\nlatest=true\n");
      expect(git(project.origin, "rev-parse", "main")).toBe(bump);
      expect(
        readFileSync(path.join(rerun, "RELEASE_NOTES.md"), "utf-8")
      ).toStartWith("## v0.1.1");
      expect(existsSync(path.join(rerun, "docs/RELEASE_NOTES.md"))).toBe(false);
    },
    INTEGRATION
  );

  test(
    "skips when main moves before the push and a push run covers the new head",
    () => {
      const project = createProject(createFixture());
      const newer = project.commit("fix: concurrent");
      git(project.work, "push", "--quiet", "origin", "HEAD:refs/heads/next");
      const ci = project.checkout("ci");
      hook(
        path.join(ci, ".git"),
        "pre-push",
        `git --git-dir="${project.origin}" update-ref refs/heads/main ${newer}`
      );

      const result = project.run("release", ci, {
        GH_TEST_RELEASES: PUBLISHED,
        GH_TEST_RUNS: runLine({ sha: newer }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        `::notice::main moved to ${newer}; https://github.com/owner/voix/actions/runs/200 releases it.`
      );
      expect(result.outputs).toBe("previous=kept\n");
      expect(result.ghCalls).toEqual([RELEASES_CALL, runsCall(newer)]);
      expect(git(project.origin, "rev-parse", "main")).toBe(newer);
      expect(git(project.origin, "tag", "--list")).toBe("v0.1.0");
    },
    INTEGRATION
  );

  test(
    "fails when origin rejects the push and main has not moved",
    () => {
      const project = createProject(createFixture());
      hook(
        project.origin,
        "pre-receive",
        "echo 'rejected by policy' >&2\nexit 1"
      );
      const result = project.run("release", project.checkout("ci"));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain(
        "::error::origin rejected the push of v0.1.1, and main has not moved"
      );
      expect(git(project.origin, "rev-parse", "main")).toBe(project.sha);
      expect(git(project.origin, "tag", "--list")).toBe("v0.1.0");
    },
    INTEGRATION
  );

  test(
    "resumes when origin took the push but the response was lost",
    () => {
      const shell = createFixture();
      const project = createProject(shell);
      const lost = path.join(shell.directory, "lost-push");
      shell.command(
        "git",
        `"${Bun.which("git")}" "$@"\nstatus=$?\n[ "$1" = push ] && { touch "${lost}"; exit 1; }\nexit $status`
      );

      const result = project.run("release", project.checkout("ci"), {
        GH_TEST_RELEASES: PUBLISHED,
      });

      expect(existsSync(lost)).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.outputs).toBe("previous=kept\npublish=true\nlatest=true\n");
      expect(git(project.origin, "rev-parse", "v0.1.1")).toBe(
        git(project.origin, "rev-parse", "main")
      );
    },
    INTEGRATION
  );

  test(
    "fails when reading origin fails, instead of reading it as moved",
    () => {
      const shell = createFixture();
      const project = createProject(shell);
      shell.command(
        "git",
        `[ "$1" = ls-remote ] && { echo 'fatal: Could not resolve host' >&2; exit 128; }\nexec "${Bun.which("git")}" "$@"`
      );
      const result = project.run("release", project.checkout("ci"));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("::error::git ls-remote origin");
      expect(result.stdout).toContain("Could not resolve host");
      expect(result.stdout).not.toContain("::notice::");
      expect(git(project.origin, "tag", "--list")).toBe("v0.1.0");
    },
    INTEGRATION
  );

  test(
    "fails when main moved and the run lookup fails",
    () => {
      const project = createProject(createFixture());
      const ci = project.checkout("ci");
      project.commit("fix: newer");
      git(project.work, "push", "--quiet", "origin", "main");

      const result = project.run("release", ci, {
        GH_TEST_RELEASES: PUBLISHED,
        GH_TEST_RUNS: "fail",
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("::error::gh api --paginate");
      expect(result.stdout).toContain("HTTP 502");
      expect(result.outputs).toBe("previous=kept\n");
      expect(git(project.origin, "tag", "--list")).toBe("v0.1.0");
    },
    INTEGRATION
  );
});

// Release decisions for scripts/release.ts. Nothing here runs a command or reads the
// environment: callers pass in what they observed (and, for the successor lookup, how to
// observe again), so tests can drive every case.

/** A decision that ends the step with an error annotation. */
export interface Failure {
  readonly kind: "fail";
  readonly message: string;
}

const fail = (message: string): Failure => ({ kind: "fail", message });

// Exact versions are stable only: cog would tag a prerelease or build metadata, and the
// publisher would make it the latest release.
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;

const STABLE_TAG = /^v\d+\.\d+\.\d+$/u;

// cog get-version can print a prerelease of the last tag; only its X.Y.Z is compared.
const CURRENT_VERSION = /^(?<core>\d+\.\d+\.\d+)(?:[-+].*)?$/u;

const BUMP_SUBJECT = /^chore\(version\): (?<tag>v\d+\.\d+\.\d+)$/u;

const BUMPS = new Set(["auto", "patch", "minor", "major"]);

/** Numeric X.Y.Z order, as `sort -V` gave the shell steps. */
const compareVersions = (left: string, right: string) => {
  const rightParts = right.split(".").map(BigInt);

  for (const [index, part] of left.split(".").entries()) {
    const difference = BigInt(part) - (rightParts[index] ?? 0n);

    if (difference !== 0n) {
      return difference > 0n ? 1 : -1;
    }
  }

  return 0;
};

/** The version in a stable `vX.Y.Z` tag. */
export const tagVersion = (tag: string) =>
  STABLE_TAG.test(tag) ? tag.slice(1) : undefined;

/** Workflow command data escaping, so a multi-line message stays one annotation. */
export const annotation = (level: "error" | "notice", message: string) =>
  `::${level}::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`;

/** What started the run. Dispatch inputs are empty on a push. */
export interface PlanRequest {
  readonly ref: string;
  readonly refName: string;
  readonly bump: string;
  readonly version: string;
}

export type BumpRequest =
  | Failure
  | {
      readonly kind: "bump";
      /** Arguments for `cog bump --dry-run`. */
      readonly args: readonly string[];
      /** An exact version, to check against `cog get-version`. */
      readonly exact?: string;
    };

export const bumpRequest = (request: PlanRequest): BumpRequest => {
  if (request.ref !== "refs/heads/main") {
    return fail(`Releases run from main, not ${request.refName}`);
  }

  if (request.version !== "") {
    return STABLE_VERSION.test(request.version)
      ? {
          args: ["--version", request.version],
          exact: request.version,
          kind: "bump",
        }
      : fail(`version must be a stable X.Y.Z, not '${request.version}'`);
  }

  const bump = request.bump === "" ? "auto" : request.bump;

  return BUMPS.has(bump)
    ? { args: [`--${bump}`], kind: "bump" }
    : fail(`bump must be auto, patch, minor, or major, not '${bump}'`);
};

/** An exact version must be above the current one: cog reads an equal one as nothing to release. */
export const exactVersionFailure = (version: string, current: string) => {
  const printed = current.trim();
  const core = CURRENT_VERSION.exec(printed)?.groups?.core;

  if (core === undefined) {
    return fail(`cog get-version printed '${printed}', not a version`);
  }

  return compareVersions(version, core) > 0
    ? undefined
    : fail(`version ${version} is not greater than the current ${printed}`);
};

export type Plan =
  | Failure
  | { readonly kind: "nothing" }
  | {
      readonly kind: "release";
      readonly tag: string;
      readonly version: string;
      /** False for a dry run, which stops after building and testing. */
      readonly publish: boolean;
    };

/** Reads `cog bump --dry-run`, which exits 0 whether or not a bump is due. */
export const planFromDryRun = (output: string, dryRun: boolean): Plan => {
  // The shell step read this through $(...), which drops trailing newlines.
  const printed = output.replace(/\n+$/u, "");

  if (printed.startsWith("No conventional commits")) {
    return { kind: "nothing" };
  }

  const version = tagVersion(printed);

  return version === undefined
    ? fail(`Unexpected output from cog bump --dry-run: ${printed}`)
    : { kind: "release", publish: !dryRun, tag: printed, version };
};

/** The commit a local tag names. */
export interface TagCommit {
  /** What refs/tags/<tag> points at, comparable with `git ls-remote` output. */
  readonly ref: string;
  /** The tagged commit's first parent; empty for a root commit. */
  readonly parent: string;
  readonly subject: string;
}

export interface ReleaseState {
  /** The commit this run planned, built, and tested. */
  readonly sha: string;
  readonly tag: string;
  /** origin's main. */
  readonly main: string;
  /** origin's refs/tags/<tag>, when it exists. */
  readonly remoteTag: string | undefined;
  readonly localTag: TagCommit | undefined;
}

export type ReleaseStep =
  | Failure
  | { readonly kind: "bump" }
  /** The bump of this commit is on origin: publish it without bumping again. */
  | { readonly kind: "resume" }
  /** main moved past this commit: see whether a release or a newer run covers it. */
  | { readonly kind: "moved" };

const isBumpOf = (state: ReleaseState) =>
  state.localTag?.parent === state.sha &&
  state.localTag.subject === `chore(version): ${state.tag}`;

export const releaseStep = (state: ReleaseState): ReleaseStep => {
  if (state.remoteTag !== undefined && isBumpOf(state)) {
    // An earlier attempt pushed this bump, then failed to publish.
    return { kind: "resume" };
  }

  if (state.main !== state.sha) {
    return { kind: "moved" };
  }

  return state.remoteTag === undefined
    ? { kind: "bump" }
    : fail(`${state.tag} already exists and is not the bump of ${state.sha}`);
};

/**
 * After `git push --atomic` failed. origin may have taken the push and lost the response
 * (resume), or main moved (moved); otherwise the rejection is an error.
 */
export const afterRejectedPush = (
  state: ReleaseState
): Exclude<ReleaseStep, { readonly kind: "bump" }> => {
  const step = releaseStep(state);

  return step.kind === "bump"
    ? fail(`origin rejected the push of ${state.tag}, and main has not moved`)
    : step;
};

/** Before publishing: origin's tag must be the local tag, on the bump of the tested commit. */
export const tagFailure = (state: ReleaseState) =>
  state.remoteTag !== undefined &&
  state.remoteTag === state.localTag?.ref &&
  state.localTag.parent === state.sha
    ? undefined
    : fail(`origin's ${state.tag} is not the bump of ${state.sha}`);

/** The object `ref` names in `git ls-remote` output. */
export const remoteRef = (output: string, ref: string) =>
  output
    .split("\n")
    .map((line) => line.split("\t"))
    .find(([, name]) => name === ref)?.[0];

/** Reads `git log -1 --format=%P%n%s <ref>`. */
export const tagCommit = (ref: string, log: string): TagCommit => {
  const [parents = "", subject = ""] = log.split("\n");

  return { parent: parents.split(" ")[0] ?? "", ref, subject };
};

// jq projections for `gh api`. Tag and branch names cannot contain tabs or newlines.
export const RELEASES_JQ = ".[] | [.tag_name, .draft, .prerelease] | @tsv";

export const RUNS_JQ =
  ".workflow_runs[] | [.id, .event, .head_branch, .head_sha, .status, .conclusion, .html_url] | @tsv";

/** Splits `@tsv` lines. Any other shape means the API changed: fail rather than guess. */
const tsv = (output: string, columns: number) =>
  output.split("\n").flatMap((line) => {
    if (line === "") {
      return [];
    }

    const fields = line.split("\t");

    if (fields.length !== columns) {
      throw new Error(`Unexpected line from gh api: ${line}`);
    }

    return [fields];
  });

const flag = (value: string | undefined) => {
  if (value !== "true" && value !== "false") {
    throw new Error(`Unexpected flag from gh api: ${value}`);
  }

  return value === "true";
};

/** Stable tags of published releases. Drafts, prereleases, and pushed tags without a release do not count. */
export const publishedTags = (output: string) =>
  tsv(output, 3).flatMap(([name = "", draft, prerelease]) => {
    const unpublished = [flag(draft), flag(prerelease)].includes(true);

    return !unpublished && STABLE_TAG.test(name) ? [name] : [];
  });

/**
 * Latest unless a newer stable release is already published, so a late re-run of an older
 * release cannot take latest from it.
 */
export const isLatest = (tag: string, published: readonly string[]) =>
  published.every((name) => compareVersions(name.slice(1), tag.slice(1)) <= 0);

/** The first published release that contains the commit, given `git tag --contains <commit>`. */
export const releasedIn = (
  published: readonly string[],
  containing: string
) => {
  const tags = new Set(containing.split("\n"));

  return published
    .filter((name) => tags.has(name))
    .toSorted((left, right) => compareVersions(left.slice(1), right.slice(1)))
    .at(0);
};

export interface WorkflowRun {
  readonly id: string;
  readonly event: string;
  readonly branch: string;
  readonly sha: string;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
}

export const workflowRuns = (output: string): WorkflowRun[] =>
  tsv(output, 7).map(
    ([
      id = "",
      event = "",
      branch = "",
      sha = "",
      status = "",
      conclusion = "",
      url = "",
    ]) => ({ branch, conclusion, event, id, sha, status, url })
  );

const ACTIVE = new Set([
  "queued",
  "in_progress",
  "waiting",
  "pending",
  "requested",
]);

/**
 * Another push run of ci for this head of main that is still going or passed: it plans,
 * and releases, everything up to that head. Dispatches never count, since a dry run
 * publishes nothing; cancelled, failed, skipped, and timed-out runs released nothing.
 */
export const isSuccessor = (run: WorkflowRun, main: string, runId: string) =>
  run.id !== runId &&
  run.event === "push" &&
  run.branch === "main" &&
  run.sha === main &&
  (ACTIVE.has(run.status) ||
    (run.status === "completed" && run.conclusion === "success"));

export interface SuccessorLookup {
  /** origin's main now. */
  readonly main: () => string;
  /** `gh api` output, through RUNS_JQ, for the ci runs of a commit. */
  readonly runs: (sha: string) => string;
  readonly sleep: (milliseconds: number) => void;
}

export type Successor =
  | { readonly kind: "found"; readonly main: string; readonly run: WorkflowRun }
  | { readonly kind: "none"; readonly main: string };

// GitHub may list a push's run a little after the push lands, so an empty answer is
// retried for about a minute.
export const RETRY_DELAYS: readonly number[] = [5000, 10_000, 15_000, 30_000];

/**
 * Looks for a successor run of origin's main, reading main again before every attempt so a
 * retry follows a head that moved on. A failed or malformed lookup throws instead of retrying.
 */
export const findSuccessor = (
  lookup: SuccessorLookup,
  runId: string,
  delays = RETRY_DELAYS
): Successor => {
  const main = lookup.main();

  const run = workflowRuns(lookup.runs(main)).find((candidate) =>
    isSuccessor(candidate, main, runId)
  );

  if (run !== undefined) {
    return { kind: "found", main, run };
  }

  const [delay, ...rest] = delays;

  if (delay === undefined) {
    return { kind: "none", main };
  }

  lookup.sleep(delay);

  return findSuccessor(lookup, runId, rest);
};

/**
 * Why nothing will release the commit. A bot bump on main has no run, since pushes made
 * with GITHUB_TOKEN start none; an unpublished one is finished by re-running its own release.
 */
export const noSuccessorMessage = (
  main: string,
  subject: string,
  published: readonly string[]
) => {
  const bump = BUMP_SUBJECT.exec(subject)?.groups?.tag;

  return bump !== undefined && !published.includes(bump)
    ? `main moved to ${main}, the ${bump} bump, which is not published yet. Re-run the release job of the run that pushed ${bump}.`
    : `main moved to ${main}, which has no ci run that can release it. Run the ci workflow on main to release.`;
};

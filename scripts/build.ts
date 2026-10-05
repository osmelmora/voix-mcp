// Usage: bun run scripts/build.ts [bun-darwin-arm64|bun-linux-x64] [--minify]
const SUPPORTED_TARGETS = ["bun-darwin-arm64", "bun-linux-x64"];

const target =
  process.argv.find((a) => a.startsWith("bun-")) ??
  `bun-${process.platform}-${process.arch}`;

const minify = process.argv.includes("--minify");

const outfile = `dist/voix-${target.replace(/^bun-/u, "")}`;

if (!SUPPORTED_TARGETS.includes(target)) {
  console.error(
    `unsupported target: ${target}; choose ${SUPPORTED_TARGETS.join(" or ")}`
  );
  process.exit(1);
}

const args = [
  "build",
  "--compile",
  `--target=${target}`,
  "src/main.ts",
  "--outfile",
  outfile,
];

if (minify) {
  args.push("--minify");
}

// Spawn the Bun that is running this script, so the embedded runtime matches the pinned version
// even when another `bun` is earlier on PATH.
const proc = Bun.spawn([process.execPath, ...args], {
  stdio: ["inherit", "inherit", "inherit"],
});

const code = await proc.exited;

if (code !== 0) {
  process.exit(code);
}

const { size } = Bun.file(outfile);

console.log(`built ${outfile} (${(size / (1024 * 1024)).toFixed(1)} MB)`);

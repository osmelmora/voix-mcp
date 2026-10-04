// Build a standalone executable. Usage: bun run scripts/build.ts [bun-darwin-arm64] [--minify]
const target =
  process.argv.find((a) => a.startsWith("bun-")) ?? "bun-darwin-arm64";

const minify = process.argv.includes("--minify");

const outfile = `dist/voix-${target.replace(/^bun-/u, "")}`;

if (target !== "bun-darwin-arm64") {
  console.warn(
    `warning: ${target} builds but is untested; the embedded ONNX runtime library is darwin-arm64 only.`
  );
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

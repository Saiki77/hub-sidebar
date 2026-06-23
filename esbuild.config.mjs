import esbuild from "esbuild";

const prod = process.argv.includes("production");

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2022",
  outfile: "main.js",
  platform: "browser",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  logLevel: "info",
});

// `node esbuild.config.mjs` (dev) watches with inline sourcemaps;
// `node esbuild.config.mjs production` does a one-shot minified build.
if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
  console.log("Watching for changes...");
}

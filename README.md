# Hub Sidebar

A small Obsidian plugin that gives the right sidebar an Obsidian
Publish ("Obsidian Hub") look, and adds the one thing CSS can't: a real,
clickable **Graph / Incoming / Outgoing** switcher on the framed graph box.

## What it does
- Frames the Local Graph (and Backlinks / Outgoing Links) in a rounded, borderless box.
- Cleans the outline into a plain "ON THIS PAGE" text list (no chevrons, no toolbar, no tab icon).
- Removes the right-sidebar hairline borders.
- Injects a top-right switcher that morphs the framed pane between Graph,
  Incoming links (backlinks), and Outgoing links — in place.
- Settings: outline tiers (1/2/3) and switcher on/off.

## Install (manual — this isn't in the community store)

The plugin needs three files in your vault: `main.js`, `manifest.json`, and `styles.css`.
Grab them from a [GitHub release](../../releases) or build them yourself (see Development).

1. Create the folder `.obsidian/plugins/hub-sidebar/` in your vault.
   - Easy route: in Obsidian, **Settings → Community plugins**. If community
     plugins are off, turn them on. Click the **folder icon** next to
     "Installed plugins" to open the plugins folder, then create `hub-sidebar` inside.
   - Finder works too (Finder can write to the iCloud vault).
2. Copy `main.js`, `manifest.json`, and `styles.css` into that folder.
3. Back in **Settings → Community plugins**, click **reload** (or reopen
   Settings), find **Hub Sidebar**, and toggle it **ON**.
4. Turn **OFF** the old `obsidian-hub-sidebar` CSS snippet
   (Settings → Appearance → CSS snippets) so the two don't duplicate rules.
5. Make sure the Local Graph is open in the right sidebar. The In/Out icons
   appear in the top-right of the frame.

The plugin best-effort enables the core **Backlinks** and **Outgoing Links**
plugins so the switcher works; if a switch fails you'll see a notice telling you
to enable them.

## Development

This is a TypeScript project bundled with esbuild (entry `src/main.ts` → root `main.js`).

```bash
npm install          # install dev dependencies
npm run dev          # esbuild watch build (inline sourcemap, no minify)
npm run build        # tsc --noEmit typecheck, then a minified production bundle
npm run lint         # eslint with the Obsidian plugin-guideline rules
```

For live iteration, symlink or copy the repo into
`.obsidian/plugins/hub-sidebar/` and run `npm run dev`, then reload the plugin
in Obsidian (Settings → Community plugins → toggle off/on, or the "Reload app" command).

`styles.css` is hand-written at the repo root and auto-loaded by Obsidian — it is
not bundled. `main.js` and `styles.css` are committed (they are the release assets).

## Release

```bash
npm version <x.y.z>  # bumps package.json, syncs manifest.json + versions.json, makes a bare tag
git push --follow-tags
```

Pushing the tag triggers `.github/workflows/release.yml`, which lints, builds,
verifies `manifest.json` version matches the tag, attests build provenance, and
publishes a GitHub release attaching `main.js`, `manifest.json`, and `styles.css`.

## Notes
- Uses `:has()` and `Workspace.revealLeaf` (added in Obsidian 1.7.2) → needs Obsidian ~1.7.2+
  (declared as `minAppVersion` in `manifest.json`).
- Theme-agnostic (core selectors + core CSS variables).
- Reaches a few undocumented-but-stable Obsidian internals (`internalPlugins`,
  a leaf's `containerEl`, a leaf view's `contentEl`/`getViewType`) through narrow
  typed casts, not `any`.

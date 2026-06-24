# Submitting Hub Sidebar to the Obsidian Community Plugins directory

Obsidian now accepts plugin submissions through a **web form** at
[community.obsidian.md](https://community.obsidian.md) — there is no longer a pull
request against `obsidianmd/obsidian-releases`. The site reads `manifest.json`
from the repo's default branch and downloads the GitHub release that matches
`manifest.version`.

## Readiness — done

- [x] `manifest.json` at the repo root with all required fields
      (`id`, `name`, `version`, `minAppVersion`, `description`, `author`,
      `authorUrl`, `isDesktopOnly`).
- [x] `id` `hub-sidebar` and `name` `Hub Sidebar` — lowercase-kebab / Title Case,
      contain neither `obsidian` nor `plugin`.
- [x] `version` `1.0.6` — valid semver, **no leading `v`**.
- [x] `versions.json` maps every release (`1.0.0`–`1.0.6`) to `minAppVersion` `1.7.2`.
- [x] `authorUrl` is a real URL (`https://github.com/Saiki77`); no empty optional fields.
- [x] `description` starts with a verb (`Frame …`), ends with a period, < 250 chars,
      and avoids the word "Obsidian".
- [x] `README.md` and `LICENSE` (MIT) at the repo root.
- [x] GitHub release tagged exactly `1.0.6` carrying `main.js`, `manifest.json`,
      and `styles.css` as individual (non-zipped) assets.

Verify the two things the directory checks:

```bash
# Release tag must equal manifest.version, with the three raw assets:
gh release view --repo Saiki77/hub-sidebar --json tagName,assets \
  --jq '.tagName, [.assets[].name]'
# Expect: "1.0.6"  and  ["main.js","manifest.json","styles.css"]

# The manifest at default-branch HEAD is what the site reads:
curl -s https://raw.githubusercontent.com/Saiki77/hub-sidebar/HEAD/manifest.json \
  | jq '.id, .version, .minAppVersion'
# Expect: "hub-sidebar"  "1.0.6"  "1.7.2"
```

## Submit (website flow)

1. Go to **[community.obsidian.md](https://community.obsidian.md)** and sign in with
   your Obsidian account.
2. **Link your GitHub account** (one-time).
3. Open **Plugins → New plugin**.
4. Enter the repository URL: `https://github.com/Saiki77/hub-sidebar`
5. Review and **agree to the Developer Policies**.
6. Click **Submit**.

The directory runs an automated review against the release and manifest. If it
flags anything, fix it, **publish an incremented release** (e.g. `1.0.7`), and the
review re-runs against the new version.

## Updating after it's published

```bash
npm version <x.y.z>     # bumps package.json, syncs manifest.json + versions.json, makes a bare tag
git push --follow-tags  # the tag push triggers .github/workflows/release.yml
```

The release workflow builds and publishes `main.js`, `manifest.json`, and
`styles.css`. **No re-submission is needed for updates** — once the plugin is in
the directory, Obsidian picks up new releases automatically. Just keep the tag
equal to `manifest.version` (no `v`).

## Notes for reviewers / future me

- The plugin reaches two undocumented-but-stable Obsidian internals
  (`app.internalPlugins` to enable the core Backlinks / Outgoing Links plugins,
  and a leaf's `containerEl`). Both go through narrow typed interfaces with
  optional chaining and `try/catch`, treat failure as non-fatal, and carry
  explanatory comments — not blanket `as any`. This is permitted; the forbidden
  list is obfuscation, hidden telemetry, remote ads, and self-updating code, none
  of which this plugin does.
- `isDesktopOnly` is `false`: the plugin only touches the DOM and the Obsidian
  `app` object (no Node `fs` / `os` / `crypto`). If it misbehaves on mobile, flip
  this to `true` and ship a new release.
- `fundingUrl` is intentionally omitted (add only a real, working sponsor URL).

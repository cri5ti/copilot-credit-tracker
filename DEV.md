# Developing Copilot Tracker Ent

How to build, test, package and publish the extension.

## Prerequisites

- Node.js 22 or newer and npm.
- VS Code 1.125 or newer (the `engines.vscode` range). The history store uses `node:sqlite`, which needs the Node runtime of a recent VS Code (1.144 has Node 24). Older builds fall back to in-memory history.
- A GitHub account that can use Copilot, for trying the extension for real.

```
npm install
```

## Layout

| Path | What it holds |
| --- | --- |
| `src/extension.ts` | Activation, refresh scheduling, GitHub calls, status bar, panel messages. |
| `src/usage.ts` | Pure maths: plans, schedules, deltas, trends. No VS Code imports, so it is easy to test. |
| `src/history.ts` | The shared SQLite store (and the in-memory fallback). |
| `src/panel.ts` | Builds the panel HTML and SVG charts. |
| `media/panel.js`, `media/panel.css` | Webview script and styles. They ship as plain files, not compiled. |
| `src/test/` | Mocha tests. |
| `docs/` | Screenshots used by the README. Not shipped in the package. |

## Build and run

```
npm run compile      # one-off build into out/
npm run watch        # rebuild on change
npm run lint
```

To try it: open the folder in VS Code and press **F5** (the "Run Extension" launch config). A second window opens with the extension loaded. Open the Command Palette there and run **Copilot Tracker Ent: Show Panel**. Output goes to the "Copilot Tracker Ent" output channel.

Notes:

- Changes to `media/` need the panel closed and reopened. Changes to `src/` need a rebuild and **Developer: Reload Window** in the test window.
- To see how several windows behave, open more windows from the F5 window. They share the same global storage, so they share the same `history.sqlite`.
- To reset local data, close all windows and delete the `history.sqlite*` files in the extension's global storage folder (`%APPDATA%\Code\User\globalStorage\cri5ti.copilot-tracker-ent` on Windows).

## Tests

```
npm test
```

This runs `pretest` (compile and lint) and then `vscode-test`, which downloads a VS Code and runs the tests in it.

The tests only touch `usage.ts` and `history.ts`, so you can also run them in VS Code's own Node, with no download (adjust the path to `Code.exe` on your machine):

```
npm run compile
ELECTRON_RUN_AS_NODE=1 "/c/Program Files/Microsoft VS Code/Code.exe" node_modules/mocha/bin/mocha.js --ui tdd out/test/extension.test.js
```

Plain `node` also works if its version has `node:sqlite` (Node 22.5 or newer).

## Screenshots

The README uses `docs/preview-light.png` and `docs/preview-dark.png` (picked by the viewer's theme on GitHub) and `docs/status-bar.png`. They are referenced by absolute `raw.githubusercontent.com` URLs on `main` for the dark/light pair, so they only show up on the Marketplace once they are on `main`. The Marketplace page can't switch by theme and uses the light one.

## Versioning and changelog

The version is in `package.json` (and the lockfile). Follow semver: while below 1.0, a minor bump (0.3.0) is for features and a patch (0.3.1) is for fixes.

For every release:

1. Add a section at the top of `CHANGELOG.md`: `## [x.y.z] - YYYY-MM-DD` with Added, Changed, Fixed or Removed lists.
2. Update the **Changelog** paragraph in `README.md` if the release is worth a highlight.
3. Set the version without creating a tag yet:

   ```
   npm version x.y.z --no-git-tag-version
   ```

4. Commit, open a PR and merge into `main`.

## Packaging

```
npm run package
```

This runs `vsce package`, which first runs `vscode:prepublish` (a compile), then writes `copilot-tracker-ent-x.y.z.vsix` in the project root. Check what went in:

```
npx @vscode/vsce ls
```

You should see `out/`, `media/`, `package.json`, `README.md`, `CHANGELOG.md`, `LICENSE` and `logo.png`. `src/`, `docs/` and the tests are excluded by `.vscodeignore`. If you add a new top-level folder the extension needs at runtime, make sure `.vscodeignore` does not exclude it.

Try the package before publishing: Extensions view, `...` menu, **Install from VSIX...**, then reload.

## Publishing to the Marketplace

The publisher is `cri5ti` (the `publisher` field in `package.json`), and the extension id is `cri5ti.copilot-tracker-ent`.

### One-time setup

1. Sign in to [Azure DevOps](https://dev.azure.com) with the Microsoft account that owns the publisher, and create an organisation if you have none.
2. Create a Personal Access Token: **User settings** > **Personal access tokens** > **New Token**. Set **Organization** to **All accessible organizations** and the scope to **Custom defined** > **Marketplace** > **Manage**. Copy the token (it is shown once).
3. Make sure the publisher exists at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) and that your account is a member.
4. Log in once from the terminal:

   ```
   npx @vscode/vsce login cri5ti
   ```

   Paste the token when asked. It is stored in your keychain.

### Each release

After the version bump and changelog are merged into `main`:

```
git checkout main
git pull
npm ci
npm test
npx @vscode/vsce publish
```

`vsce publish` packages and uploads the version currently in `package.json`. To bump and publish in one go use `npx @vscode/vsce publish minor` (or `patch`), but that edits `package.json` and creates a git commit and tag itself, so skip it if you already bumped the version and wrote the changelog by hand.

Alternatives:

- **Upload a file:** build with `npm run package`, then upload the `.vsix` on [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage) with **...** > **Update**.
- **Token from the environment (CI):** set `VSCE_PAT` and run `npx @vscode/vsce publish`.

The new version usually shows up in the Marketplace within a few minutes, after an automatic validation. VS Code installs update it on their own.

Afterwards:

```
git tag vx.y.z
git push origin vx.y.z
```

Then create a GitHub release for the tag and attach the `.vsix`.

### Things that can go wrong

- **`TF400813` or 401 when publishing:** the token is for the wrong organisation scope or has expired. Create a new one as above and run `vsce login` again.
- **Version already exists:** the Marketplace never accepts the same version twice. Bump it, even for a one-line fix.
- **Images missing on the Marketplace page:** README images must be `https` URLs. Relative paths are rewritten to GitHub, so they only work once the files are on the default branch of the public repository.
- **Warning about a missing `repository` or `license`:** both are set in `package.json`; keep them.
- **The panel is blank after install:** check that `media/` is in the package (`npx @vscode/vsce ls`).
- **Unpublish or deprecate:** use the manage page. Unpublishing removes the listing for everyone, so prefer publishing a fixed version.

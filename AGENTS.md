# Music Together — Agent Guidelines

## Pull Requests & Before / After Demos (Mandatory for UI Changes)

Every pull request that changes UI, layout, interaction, or animation **must** include a visual **Before / After comparison** in the PR description before asking for review or merging:

- **Motion / interaction changes**: Attach a side-by-side Before / After animated GIF recorded from the real extension UI in a browser (with clear cursor/click cues where helpful).
- **Static layout changes**: Attach a side-by-side Before / After screenshot.
- **Asset hosting**: Store PR demo files on the independent orphan branch `origin/pr-assets` under `pr-<number>/` and reference them via `https://raw.githubusercontent.com/etak64n/musictogether/<commit-sha>/pr-<number>/...` so `main` and PR diffs stay clean of binary review media. Verify HTTP 200 on every embedded URL.
- **Language & naming conventions**:
  - The product is **English-first** (Japanese is secondary). Show the English UI demo at the top of the PR description and place the Japanese UI demo inside a collapsible `<details>` block.
  - Use natural member names in demos: `Alex` / `Maya` (English) and `ユウ` / `ハル` (Japanese).

## UI & Accessibility Conventions

- Keep animations crisp, lightweight, and subtle — avoid heavy shadows or noisy accents.
- Always respect `@media (prefers-reduced-motion: reduce)` in CSS and `matchMedia('(prefers-reduced-motion: reduce)').matches` in JS for all animations and transitions.
- Never let clickable elements inside queue rows trigger drag-reordering (`<button>` elements are automatically excluded by `#queue-body`'s `pointerdown` handler).

## Verification

Before opening or merging a PR, run the relevant checks:

- **Extension**: `node --check` on modified JS files and `jq empty extension/manifest.json`
- **Server**: `go test -race ./...` inside `server/`
- **Docs**: `pnpm exec astro build` inside `docs/` when editing `docs/`

## Release Checklist

1. Bump the version in all 4 locations:
   - `extension/manifest.json`
   - `server/main.go`
   - `docs/src/content/docs/getting-started/server.md`
   - `docs/src/content/docs/reference/api.md`
2. Commit `Release X.Y.Z` on `main` and push an annotated tag `vX.Y.Z` (the tag message becomes the GitHub Release notes via `.github/workflows/release.yml`, and the tag also triggers `.github/workflows/docs.yml`).
3. Wait for `Release` workflow success, then update the production server (`home-acemagic:/opt/musictogether`) and verify `https://musictogether.etak64n.dev/` returns `Music Together server X.Y.Z`.

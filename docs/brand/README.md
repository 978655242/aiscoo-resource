# Brand assets

| Brand  | Directory                     | Description                                                                                                                     |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Aiscoo | [`aiscoo/`](aiscoo/README.md) | App icon, app logo (static and animated), splash page, and the "ai" mark. Open `aiscoo/preview.html` to see everything at once. |

## Conventions

- Each brand has its own directory, with `preview.html`, `README.md`, and the generator scripts in `source/`.
- Change parameters in `source/` and regenerate. Don't hand-edit generated SVG or PNG files.
- `.skill-archive/logo-creator/Aiscoo-Logo-Final/` is an exact mirror of `docs/brand/aiscoo/`, including generators, previews, SVGs and binary formats. Update the canonical package here, then use its [synchronization command](aiscoo/README.md#设计工具镜像); the archive does not maintain a separate design. The [verification record](../aiscoo/branding/robot-motion-verification.md) separates historical branch evidence from checks rerun for the PR #52 extraction (`f52e110d`, based on `cd4af779`), not the current local release merge, covering 39 mirrored design files, the icon specification and 11 current feature documents.
- Aiscoo is the active product brand. The `ai` mark and lowercase `aiscoo` wordmark share the same light/dark SVG source, with capsule eyes in static assets and filled smile eyes plus a head bounce in the 10-second animated cycle. Theme selection, reduced-motion behavior and current placements follow the [icon and display-name specification](../aiscoo/branding/icon-spec.md). Production resources are generated into `packages/ui/src/aiscoo/brand/assets`, `packages/desktop/build`, `packages/web/public` and `public/logo/icons` (the standalone share app reuses `packages/web/public`); runtime code does not read this documentation directory.
- Regenerate production assets with `python3 scripts/xcode/generate-icons.py`. The [brand integration checklist](../aiscoo/branding/aiscoo-migration.md) records display-name, packaging and compatibility coverage.

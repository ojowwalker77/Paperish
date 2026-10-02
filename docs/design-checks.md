# Design checks

Paperish checks designs against the repo's design system, so a team without a designer still ships consistent screens:
- **DESIGN.md.** The repo's [DESIGN.md](https://github.com/google-labs-code/design.md) is the design system: its YAML tokens (typography, spacing, rounded, colors) and its "Do's and Don'ts". Paperish uses the one at the repo root; for one elsewhere, click DESIGN.md in the status bar and pick it (saved as `designMd` in `design/paperish.json`, so the team shares it).
- **Tailwind theme.** Tokens can also come from a Tailwind v4 stylesheet: set `tokens` in `design/paperish.json` to its path, and its `@theme` colors, radii, spacing, text sizes and fonts are checked too, with `var()` resolved through `@theme` and `:root`. Where both define a token, DESIGN.md wins.
- **Issues.** The status bar shows the DESIGN.md in use and the page's issue count; L opens the list. Contrast (WCAG AA), text sizes, fonts, spacing and corners are measured in the layout engine and checked against the tokens (without a DESIGN.md: contrast and the 4px grid). Off-scale values have a fix that snaps them to the nearest token.
- **Do's and Don'ts** are judged by [Jev](https://openrouter.ai/typesafe/jev-1.13), TypeSafe's decision model, through OpenRouter's Decisions API. Add an OpenRouter key in Settings (⌘,) or set `OPENROUTER_API_KEY`; it's kept in the app's data folder, never sent to the editor.
- **Agents** get the same checks with `lint_design` (`fix: true` applies the fixes), and the guide tells them to run it before finishing.

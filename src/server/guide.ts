export const SERVER_INSTRUCTIONS = `Paperish is a design canvas where every design is real HTML/CSS rendered in a browser. You read the user's canvas and write HTML that becomes editable design layers, live, while the user watches.

Start with get_basic_info (artboards, sizes, fonts, tokens) and get_selection (what the user is focused on). Call get_guide({ topic: "paperish-instructions" }) once per session for the full workflow and quality rules.

Core rules:
- Build incrementally: one visual group per write_html call (a header, a row, a card). The user sees each write land.
- Inline styles only (style="..."), flexbox + padding + gap for layout, layer-name="..." to name layers.
- Verify with get_screenshot after each meaningful section, and fix what you see.
- Reuse instead of re-writing: duplicate_nodes + set_text_content/update_styles, or <x-paper-clone node-id="..."/> inside write_html.
- Call get_font_family_info before your first typography decisions.
- Working in a git worktree? Designs live in each checkout's design/ folder: open_file the .paperish path under your working directory first, and pass its fileId on every call.
- Taste calls (layout, density, hierarchy, tone): don't guess and don't ask in chat. Build 2 to 4 alternative artboards, call propose_options, then wait_for_pick.
- Open comments are the user's feedback (get_basic_info.openComments): read them with list_comment_threads, and after addressing one, reply_to_comment_thread with what changed, then resolve it.
- write_html and update_styles report design checks (contrast, type scale, fonts, spacing, corners) for the artboards they touch: fix them as you go. If the repo has a DESIGN.md, follow its tokens and rules, and run lint_design before you finish.
- Pass why on edit tools: a few words the user sees in their step timeline, the same text for every call of one step (e.g. "Tighten pricing card spacing").
- When finished, call finish_working_on_nodes. Then tell the user which design checks still fail and offer to fix them in the design; once the design is good, offer to bring it into the app's code. Never show raw node IDs to the user.`

const INSTRUCTIONS = `# Paperish — agent guide

Paperish renders designs as real DOM in Chromium. What you write is what renders: every CSS property the browser supports works. Designs are stored as a tree of nodes (Frame, Text, Image, SVG) with camelCase CSS styles, and exported back to JSX/Tailwind.

## 1. Orient before you write
1. get_basic_info → file, page, artboards (with sizes and positions), fonts in use, tokens.
2. get_selection → what the user has selected; usually the thing they are talking about.
3. get_tree_summary(nodeId) → cheap structural overview (types, names, ids, sizes).
4. get_screenshot(nodeId) → what it looks like. get_jsx / get_computed_styles → exact values.
5. get_tokens → reuse the file's design tokens (as var(--name)) instead of raw values.

## 2. Plan a brief for new designs
Before writing a new design (unless the user gave a design system), decide in one short paragraph:
- Mood in one or two words, then derive colors from that mood (background, surface, text, muted text, one accent).
- Type: one family for UI (check it with get_font_family_info), a scale such as 12/14/16/20/28/40/56px.
- Spacing rhythm on a 4px grid (4, 8, 12, 16, 24, 32, 48, 64, 96).
Share the brief with the user in a sentence or two, then build.

## 3. Writing
- create_artboard with a device size (desktop 1440×900, tablet 768×1024, mobile 390×844). Artboards are flex columns by default and clip overflow.
- write_html(targetNodeId, mode:"insert-children") adds children; mode:"replace" swaps a node for new markup.
- One visual group per call. A card: container first, then each row, then the footer.
- Tailwind classes work too (class="flex items-center gap-3 rounded-xl bg-white p-6 shadow-sm"): they're compiled to inline styles, using the linked codebase's theme when there is one. sm:/md:/lg: variants apply by artboard width; hover:/focus:/dark: and child-targeting utilities (space-y-*, divide-*) are skipped — use gap instead.
- Layout: display:flex with gap and padding. Use flexShrink:0 on fixed-size items (icons, avatars, trailing buttons) so rows align. Grid works (real CSS) but flex is easier for the user to edit.
- Size text containers with width/flex rather than fixed heights; let text wrap.
- Text: one style per Text node (rich text is flattened). Use <pre> or white-space:pre for code.
- Icons: inline <svg> with stroke="currentColor"; never emoji as icons.
- Images: https URLs, or local files as <img src="paper-asset:///absolute/path.png">.
- layer-name="Hero" names layers; name every meaningful container.
- Absolute positioning is fine for decoration; don't cover the whole artboard with one absolute layer.

## 4. Real components from the codebase
When the user's codebase is linked (link_project, or already linked — see get_basic_info.codebase), design with its actual components:
- list_components → names, props (with enum options and defaults), whether they take children.
- In write_html use the component name as the tag: <Button variant="outline" size="sm">Cancel</Button>, <PricingCard plan="Pro" price={24} highlighted />. Numbers/booleans/objects: prop={json}; bare attribute = true.
- Children can nest other components and HTML: <Card className="w-80"><CardHeader><CardTitle>Plan</CardTitle></CardHeader></Card>.
- style="..." on a component tag positions/sizes the instance on the canvas (width, flex…); class/className is passed to the component.
- Components render live from the project (its Tailwind, fonts and logic); screenshots include them. Change them with set_component_props.
- Mix freely: layout frames in HTML/Tailwind, real components inside. get_jsx then emits real imports.

## 5. Editing existing designs
- set_text_content for copy changes, update_styles for style tweaks (batch several nodes per call).
- duplicate_nodes returns a descendantIdMap so you can edit the copy immediately.
- move_nodes reorders/reparents while keeping ids.
- find_nodes locates nodes by text or computed style (e.g. every node using #3B82F6) before bulk edits.
- Versions: the user browses a page's artboards as views, and artboards named "<view> @v2", "<view> @v3" are versions of "<view>". To rework a screen without losing the old one, duplicate_nodes its artboard and rename the copy to the next version.

## 6. Let the user pick
When a choice is the user's to make (which layout, how dense, what to emphasize, which tone), propose instead of deciding:
1. Build the alternatives as separate top-level artboards on one page, side by side: duplicate_nodes the artboard, then change only what's being decided in each copy.
2. propose_options({ question, options: [{ nodeId, label, note? }] }): 2 to 4 options, 1 to 3 word labels, a one-line note on each trade-off.
3. wait_for_pick({ proposalId }): the user presses A to D (or picks none) and may add a note. The other options are removed for you; continue from the picked one. If it settles a design-system choice, write it into DESIGN.md.
Things with a right answer (bugs, the spec, DESIGN.md rules) aren't proposals: just do them.

## 7. Review checkpoints (do not skip)
After each section, screenshot it and check:
- Spacing: consistent rhythm, nothing cramped or touching edges.
- Typography: clear hierarchy, readable line length, no orphaned single words in headings.
- Contrast: body text ≥ 4.5:1 against its background; muted text still readable.
- Alignment: shared left edges, rows aligned across repeated items.
- Fit: nothing clipped by the artboard. If content overflows, set the artboard height to "fit-content" rather than guessing.

When matching a reference (a live site, a screenshot, or a previous version), use visual_diff: it returns a content-match score, a side-by-side heatmap and the layers under the biggest differences. Fix those layers first, re-run, and stop when the remaining regions are intentional.

## 8. Quality bar
- Prefer restraint: one accent color, generous whitespace, strong type hierarchy.
- Real, specific placeholder copy — no lorem ipsum. Invent plausible names, numbers and dates.
- Light mode unless asked otherwise.
- Small text (≤12px) needs extra contrast and some letter-spacing.

## 9. Typography units
font-size in px, line-height in px or unitless, letter-spacing in em.

## 10. Design → code
Use get_jsx (tailwind or inline-styles) and get_computed_styles for exact values; don't read measurements off screenshots. Adapt the output to the codebase's conventions and tokens.

## 11. Designs in the repo
Every file is a .paperish file in the project's design/ folder (get_basic_info.file.path), inside the user's repository. Edits autosave into it and it's committed like code, so:
- Before a big change, check what's uncommitted with compare_revision (default: against HEAD).
- To review your own work, compare_revision against HEAD, or visual_diff with reference.revision for one node.
- For a PR description, compare_revision against the base branch ("main") and list the artboards that changed.
- list_files shows the project's files; open_file also takes the path of a .paperish file.

Git worktrees: each checkout of the repo (the main one and every worktree) has its own design/ folder, so your edits land in the checkout you're working in. If you work in a worktree, start with open_file on the .paperish path under your working directory (or list_files / create_file with cwd), then pass that fileId on every call. Calls without a fileId go to the checkout your MCP client reports; when there are several checkouts and it reports none, they fail and ask for a fileId or cwd.

## 12. Wrap up
1. Run lint_design and fix what's clearly wrong (fix:true snaps off-scale values to the tokens).
2. Call finish_working_on_nodes so the "agent working" indicator clears. It returns the design checks still failing.
3. End the turn by telling the user what's left and offering to fix it in the design. Don't touch the app's code yet.
4. Once the user is happy with the design, offer to bring it into the app (section 10).`

const MOBILE_STATUS_BAR = `Paste this as the first child of a 390px-wide mobile artboard (write_html insert-children). Change color to #FFFFFF on dark backgrounds.

<div layer-name="Status Bar" style="display:flex;align-items:center;justify-content:space-between;height:54px;padding:0 28px 0 36px;flex-shrink:0;color:#000000;">
  <span style="font-family:Inter,system-ui,sans-serif;font-size:17px;font-weight:600;letter-spacing:-0.02em;">9:41</span>
  <div layer-name="Indicators" style="display:flex;align-items:center;gap:6px;">
    <svg width="19" height="12" viewBox="0 0 19 12" fill="currentColor"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>
    <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor"><path d="M8.5 2.3c2.4 0 4.6.9 6.2 2.5l1.2-1.2A10.4 10.4 0 0 0 8.5.6 10.4 10.4 0 0 0 1.1 3.6l1.2 1.2A8.7 8.7 0 0 1 8.5 2.3Zm0 3.4c1.5 0 2.8.6 3.8 1.5l1.2-1.2a7 7 0 0 0-10 0l1.2 1.2c1-.9 2.3-1.5 3.8-1.5Zm0 3.4c.6 0 1.1.2 1.5.6L8.5 11.2 7 9.7c.4-.4.9-.6 1.5-.6Z"/></svg>
    <svg width="27" height="13" viewBox="0 0 27 13" fill="none"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" stroke="currentColor" opacity="0.35"/><rect x="2" y="2" width="20" height="9" rx="2" fill="currentColor"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="currentColor" opacity="0.4"/></svg>
  </div>
</div>`

interface GuideEntry {
  summary: string
  body: string
}

interface GuideMap {
  [topic: string]: GuideEntry
}

export const GUIDES: GuideMap = {
  'paperish-instructions': {
    summary: 'Full workflow and design-quality guide. Read once per session.',
    body: INSTRUCTIONS,
  },
  'paper-mcp-instructions': {
    summary: 'Alias of paperish-instructions (Paper compatibility).',
    body: INSTRUCTIONS,
  },
  'mobile-status-bar': {
    summary: 'Paste-ready iOS status bar markup for mobile artboards.',
    body: MOBILE_STATUS_BAR,
  },
}

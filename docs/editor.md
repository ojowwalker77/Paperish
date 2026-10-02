# Editor

| Keys | Action |
| --- | --- |
| `V` / `F` / `T` / `H` / `C` | Move, frame, text, hand and comment tools |
| Space + drag, scroll | Pan |
| ⌘ + scroll, pinch | Zoom |
| ⇧1 / ⇧2 | Fit all / fit selection |
| Double-click | Drill into a layer; on text, edit it |
| Enter / Esc | Select children / parent |
| ⌘-click | Select the deepest layer |
| ⌘D, ⌫, arrows | Duplicate, delete, nudge |
| ⌘Z / ⇧⌘Z | Undo / redo, shared with the agent |
| ⌘C / ⌘V | Copy as HTML; paste any HTML to turn it into layers |
| ⌘\ | Hide / show both side panels (each also has a toggle in the top bar) |
| P | Preview the selected artboard as a full page UI (Fit / 100% / Responsive, ← → between artboards, Esc to close). "Open in new tab" gives a live standalone URL (`/?file=…&view=…`) |

**Device previews.** Responsive mode can render the frame inside a phone shell at that device's CSS viewport, so layouts reflow as they would on the phone:

| Device | Viewport | Notes |
| --- | --- | --- |
| iPhone 18 Pro | 402 × 874 @3x | Smaller Dynamic Island (size estimated) |
| iPhone 17 | 402 × 874 @3x | |
| iPhone Duo | 466 × 678 folded, 890 × 626 open | Fold/Open toggle, hole-punch outside, crease inside. Apple hasn't published browser values; these assume @3x |

Each shell has:
- a status bar whose icons switch between light and dark to match the page under them
- a home indicator, or the iOS 26 Safari Liquid Glass bar (the "Safari" toggle)
- side buttons, and the finishes of each model

The frame design is adapted from [liquidframe](https://github.com/CVERInc/liquidframe) (MIT); see [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

The inspector edits common properties, or the node's full CSS directly. It can also copy the selection as Tailwind JSX, inline-style JSX, or HTML.

## Comments

Press C (or the comment count in the status bar) for comment mode: pins show on the canvas and the threads open in a panel. Click a layer to pin a comment to it; reply, resolve or delete from the panel. You're named from the checkout's `git config user.name`; agents sign with their own name, and their pins are orange. Comments live in the `.paperish` file and stay out of undo, so undoing an edit never drops one. Agents see `openComments` in `get_basic_info`, reply with `reply_to_comment_thread` once they've addressed one, then resolve it; `create_comment_thread` leaves a note for later.

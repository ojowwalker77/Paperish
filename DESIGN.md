---
version: alpha
name: Paperish
description: A calm design canvas for software engineers and their agents. The canvas is the whole window; chrome floats over it as quiet, neutral sheets.
colors:
  bg: "#f5f5f5"
  frame: "#eaeaea"
  surface: "#ffffff"
  text: "#141414"
  muted: "#6b6b6b"
  faint: "#a3a3a3"
  ghost: "#cccccc"
  accent: "#0a84ff"
  agent: "#ff7a1a"
  danger: "#e5484d"
  success: "#30a46c"
  bg-dark: "#1c1c1c"
  frame-dark: "#141414"
  surface-dark: "#252525"
  text-dark: "#ededed"
  muted-dark: "#a1a1a1"
  faint-dark: "#707070"
  ghost-dark: "#4d4d4d"
  accent-dark: "#3b9bff"
typography:
  display:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: 600
    letterSpacing: -0.02em
  title:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 500
  emphasis:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 500
  body:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 400
    letterSpacing: -0.003em
  small:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: 400
  meta:
    fontFamily: Inter
    fontSize: 10.5px
    fontWeight: 400
  mono:
    fontFamily: ui-monospace
    fontSize: 11px
    fontWeight: 400
rounded:
  xs: 3px
  sm: 6px
  md: 8px
  lg: 12px
  full: 999px
spacing:
  "2": 2px
  "4": 4px
  "6": 6px
  "8": 8px
  "10": 10px
  "12": 12px
  "14": 14px
  "16": 16px
  "20": 20px
  "24": 24px
  "32": 32px
  "40": 40px
  "48": 48px
components:
  sheet:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.lg}"
    padding: 6px
  control:
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    height: 28px
    padding: 0 8px
  button-primary:
    backgroundColor: "{colors.text}"
    textColor: "{colors.surface}"
    rounded: "{rounded.md}"
    height: 28px
    padding: 0 12px
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    height: 28px
    padding: 0 8px
---

# Paperish

## Overview

Paperish is a tool, not a showcase. The designs on the canvas are the only thing on screen that should draw the eye; everything Paperish adds is a gallery wall around them. It is built for software engineers, so it reads like a good editor: dense but unhurried, keyboard first, with nothing that blinks or begs for attention.

There are no sidebars. The canvas fills the window, and panels (inspector, command palette, issues, the pick bar) float over it as sheets that appear on demand and go away when done.

## Colors

Chrome is neutral grey with no tint. Three colors carry meaning, and each has one job:

- **Accent** (`#0a84ff`, `#3b9bff` in dark): selection, focus rings and links. Nothing decorative.
- **Agent** (`#ff7a1a`): an agent is working. The orange halo and "Agent" chip on artboards.
- **Danger** and **success**: errors, failed checks, deletions; passed checks and clean state.

Separation comes from hairlines: black at 6% (10% for stronger edges) on light, white at 8% (14%) on dark. Hover and pressed states are the same ink at 3.5% and 6%.

Paperish follows the system appearance. Every chrome color has a dark value (the `-dark` tokens); designs on the canvas keep their own colors in both modes.

## Typography

Inter at 12px is the default, with a slight negative tracking (-0.003em) and the `cv11` and `ss01` features on. Monospace (`ui-monospace`, SF Mono on macOS) is for code, paths, keyboard shortcuts and values an engineer might copy.

The scale is small on purpose: 10.5px meta, 11px small and mono, 12px body, 13px emphasis, 14px titles, 20px for the one heading on the home screen. Weight carries hierarchy before size does: 400 for text, 500 for labels and emphasis, 600 only for headings and single letters like the A to D pick badges.

## Layout

Spacing sits on a 2px grid up to 16px, then 20, 24, 32, 40, 48. Controls are 28px tall with 8px horizontal padding; floating bars are 40px. Panels keep 12px from the window edge.

## Elevation and shapes

Floating sheets use 12px corners, a hairline ring and one soft shadow (`0 10px 30px -14px` at 10%, stronger in dark). Controls inside them use 6 to 8px corners, small swatches and tags 3px, pills 999px. Nothing else casts a shadow.

## Components

- **Sheet**: White (`#252525` in dark), 12px corners, hairline ring, soft shadow.
- **Control**: 28px, muted text that turns to full text color with a hover wash. No borders.
- **Primary button**: filled with the text color, at most one per surface.
- **Input**: a faint ink wash at rest; white with an accent focus ring when focused.
- **Keyboard hint**: a `kbd` in mono at 11px next to the action it triggers.

## Do's and Don'ts

- Do keep chrome neutral grey; the designs, the blue accent and agent orange are the only colors on screen.
- Do use the accent only for selection, focus and links, never for decoration.
- Do reserve orange for agent activity.
- Do separate surfaces with hairlines and whitespace instead of solid borders.
- Do float panels over the canvas as sheets instead of docking sidebars.
- Do give every color a dark-mode value.
- Do show the keyboard shortcut next to an action when it has one.
- Do write labels in sentence case, short and plain.
- Don't use more than one filled button on a surface.
- Don't use gradients, glows, colored panel backgrounds or decorative illustration in chrome.
- Don't use weight 700 or above in chrome.
- Don't show raw node IDs, stack traces or internal names to the user.

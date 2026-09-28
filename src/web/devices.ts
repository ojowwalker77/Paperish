// Device presets for the responsive preview. Sizes are CSS px (points).
//
// Sources (September 2026):
// - iPhone 17 / 18 Pro: 6.3" 2622×1206 @3x -> 402×874 (screensize.io, webmobilefirst)
// - iPhone 18 Pro Dynamic Island is smaller than 17 Pro's; exact size unpublished, estimated here.
// - iPhone Duo: outer 5.4" 1398×2034, inner 7.6" 2670×1878 (MacRumors, Apple). Apple has not
//   published browser values; 466×678 / 890×626 assume DPR 3 (screensize.io estimate).
// Corner radii, bezels and button positions are visual approximations.

export interface DeviceButton {
  side: 'left' | 'right' | 'top'
  /** Offset along the edge, from the top (or left for 'top'), in px. */
  at: number
  length: number
  kind?: 'camera-control'
}

export type Cutout =
  | { kind: 'island'; width: number; height: number; top: number }
  | { kind: 'hole'; size: number; top: number }
  | { kind: 'none' }

export interface DeviceScreen {
  label: string
  width: number
  height: number
  /** Display corner radius. */
  radius: number
  /** Black border between glass edge and pixels. */
  bezel: number
  cutout: Cutout
  safeTop: number
  safeBottom: number
  /** 'island': time and icons centred either side of the cutout; 'edges': pushed to the corners. */
  statusLayout: 'island' | 'edges'
  crease?: boolean
  buttons: DeviceButton[]
}

export interface Finish {
  name: string
  /** Frame edge color. */
  edge: string
  /** Darker inner chassis ring. */
  inner: string
}

export interface Device {
  id: string
  name: string
  dpr: number
  screens: DeviceScreen[]
  finishes: Finish[]
}

const PHONE_BUTTONS: DeviceButton[] = [
  { side: 'left', at: 150, length: 34 },
  { side: 'left', at: 206, length: 66 },
  { side: 'left', at: 286, length: 66 },
  { side: 'right', at: 214, length: 100 },
  { side: 'right', at: 560, length: 64, kind: 'camera-control' },
]

export const DEVICES: Device[] = [
  {
    id: 'iphone-18-pro',
    name: 'iPhone 18 Pro',
    dpr: 3,
    screens: [
      {
        label: 'Portrait',
        width: 402,
        height: 874,
        radius: 62,
        bezel: 5,
        cutout: { kind: 'island', width: 102, height: 33, top: 12 },
        safeTop: 62,
        safeBottom: 34,
        statusLayout: 'island',
        buttons: PHONE_BUTTONS,
      },
    ],
    finishes: [
      { name: 'Silver', edge: '#d9d9d6', inner: '#b9b9b5' },
      { name: 'Graphite', edge: '#46474a', inner: '#2c2d2f' },
      { name: 'Orange', edge: '#e0793a', inner: '#b85d27' },
    ],
  },
  {
    id: 'iphone-duo',
    name: 'iPhone Duo',
    dpr: 3,
    screens: [
      {
        label: 'Folded',
        width: 466,
        height: 678,
        radius: 46,
        bezel: 6,
        cutout: { kind: 'hole', size: 11, top: 16 },
        safeTop: 50,
        safeBottom: 24,
        statusLayout: 'island',
        buttons: [
          { side: 'right', at: 120, length: 72 },
          { side: 'top', at: 300, length: 56 },
          { side: 'top', at: 364, length: 56 },
        ],
      },
      {
        label: 'Open',
        width: 890,
        height: 626,
        radius: 38,
        bezel: 7,
        cutout: { kind: 'none' },
        safeTop: 32,
        safeBottom: 22,
        statusLayout: 'edges',
        crease: true,
        buttons: [
          { side: 'right', at: 72, length: 72 },
          { side: 'top', at: 724, length: 56 },
          { side: 'top', at: 788, length: 56 },
        ],
      },
    ],
    finishes: [
      { name: 'Night Sky', edge: '#2c2f38', inner: '#1b1d23' },
      { name: 'Star White', edge: '#ecebe6', inner: '#cfcdc6' },
    ],
  },
  {
    id: 'iphone-17',
    name: 'iPhone 17',
    dpr: 3,
    screens: [
      {
        label: 'Portrait',
        width: 402,
        height: 874,
        radius: 62,
        bezel: 6,
        cutout: { kind: 'island', width: 126, height: 37, top: 11 },
        safeTop: 62,
        safeBottom: 34,
        statusLayout: 'island',
        buttons: PHONE_BUTTONS,
      },
    ],
    finishes: [
      { name: 'Black', edge: '#3a3b3e', inner: '#232426' },
      { name: 'White', edge: '#eceae5', inner: '#cbc9c3' },
      { name: 'Lavender', edge: '#cfc3dc', inner: '#a99dba' },
      { name: 'Sage', edge: '#bcc5ab', inner: '#98a386' },
      { name: 'Mist Blue', edge: '#b9c8d8', inner: '#93a5b8' },
    ],
  },
]

export function deviceById(id: string | null | undefined): Device | undefined {
  return DEVICES.find((d) => d.id === id)
}

/** Outer size of the rendered shell (frame + room for protruding buttons). */
export function shellSize(s: DeviceScreen) {
  const edge = 2 // titanium ring drawn with box-shadow
  const buttonRoom = 8
  return {
    width: s.width + s.bezel * 2 + (edge + buttonRoom) * 2,
    height: s.height + s.bezel * 2 + (edge + buttonRoom) * 2,
  }
}

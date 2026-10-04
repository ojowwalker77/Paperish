import type { ComponentInfo, IconSet } from './types'

export function iconComponents(icons: IconSet | undefined): ComponentInfo[] {
  if (!icons) return []

  return icons.names.map((name) => ({
    id: `${icons.module}#${name}`,
    name,
    file: icons.module,
    export: name,
    framework: icons.framework,
    importPath: icons.module,
    props: [],
    slot: false,
  }))
}

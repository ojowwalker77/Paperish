// The canvas reset. Designs are real DOM, so the browser's UA styles would
// otherwise leak in (h1 margins, button chrome...). This mirrors Tailwind's
// preflight so exported JSX renders the same in a typical app.

export const DEFAULT_FONT = 'Inter'

export function canvasResetCss(scope: string): string {
  const s = (sel: string) =>
    sel
      .split(',')
      .map((x) => `${scope} ${x.trim()}`)
      .join(',')

  return `
${scope}{font-family:${DEFAULT_FONT},system-ui,sans-serif;font-size:16px;line-height:normal;color:#000;font-weight:400;letter-spacing:normal;text-align:left;-webkit-font-smoothing:antialiased;}
${s('*,*::before,*::after')}{box-sizing:border-box;margin:0;padding:0;border:0 solid;}
${s('h1,h2,h3,h4,h5,h6')}{font-size:inherit;font-weight:inherit;}
${s('a')}{color:inherit;text-decoration:inherit;}
${s('b,strong')}{font-weight:bolder;}
${s('small')}{font-size:80%;}
${s('img,svg,video,canvas,iframe')}{display:block;vertical-align:middle;}
${s('img,video')}{max-width:100%;height:auto;}
${s('button,input,select,textarea')}{background:transparent;font:inherit;color:inherit;letter-spacing:inherit;border-radius:0;}
${s('ul,ol,menu')}{list-style:none;}
${s('pre,code,kbd,samp')}{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1em;}
${s('hr')}{height:0;color:inherit;border-top-width:1px;}
${s('table')}{text-indent:0;border-color:inherit;border-collapse:collapse;}
`
}

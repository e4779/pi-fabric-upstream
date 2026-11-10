// Public `pi-fabric/highlight`: the shiki-backed syntax highlighter for
// extension-drawn rows and cards (host-quality highlighting without shiki
// as an extension dependency). The highlighting config (theme name, on/off)
// is applied host-side by configureHighlighting at extension start; a caller
// feeds the live session theme variant via observePiTheme(theme) before
// rendering. highlightCode returns null while shiki initializes or when
// highlighting is disabled - render the plain text and retry on the next
// render pass.
export {
  effectiveShikiTheme,
  highlightCode,
  languageFromPath,
  observePiTheme,
} from "./ui/highlight.js";
export type { PiThemeLike } from "./ui/highlight.js";

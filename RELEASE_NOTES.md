## PDF-Bat 0.2.0 — LaTeX

**New in Edit mode:**
- **LaTeX documents**: *∑ New .tex* (or Ctrl+N / open a `.tex`). Templates: English article, Ukrainian article, problem solution, blank. Syntax highlighting, auto-compile while typing, errors with click-to-line, PDF preview next to the source.
- **LaTeX on any PDF page**: `L` tool → click on the page → type a formula, text with `$…$`, or TikZ → it is placed as vector graphics, movable and resizable, double-click to edit. Your macros go in the remembered *Preamble*.
- LaTeX engine: **Tectonic** is downloaded on first use (needs internet once; it fetches packages on demand). An installed MacTeX / MiKTeX / TeX Live is detected automatically.
- LaTeX is only loaded in Edit mode.

**Reading:** `Ctrl+J` (Cmd+J) opens the same file side by side.

### Install
- **Windows:** `PDF-Bat-Setup-0.2.0.exe`. SmartScreen may warn (not code-signed yet): *More info → Run anyway*.
- **macOS:** `arm64` .dmg for Apple Silicon, `x64` for Intel. First launch: right-click PDF-Bat → *Open*. If macOS says it is damaged: `xattr -cr /Applications/PDF-Bat.app` in Terminal.

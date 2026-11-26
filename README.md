# PDF-Bat

A minimalist desktop PDF reader and editor for studying technical books and writing papers. macOS (.dmg) and Windows (.exe).

## Download

Installers for every version are on the [Releases](../../releases) page.

- **Windows:** run `PDF-Bat-Setup-x.y.z.exe`. SmartScreen may warn because the app is not code-signed yet: *More info → Run anyway*.
- **macOS:** open the `.dmg` (`arm64` for Apple Silicon, `x64` for Intel) and drag PDF-Bat to Applications. The app is not notarized yet, so the first time: right-click PDF-Bat → *Open* → *Open*. If macOS says the app is damaged, run `xattr -cr /Applications/PDF-Bat.app` in Terminal once.

## Read mode

- Several PDFs side by side; **split** the same file side by side (⧉ / Ctrl+J) to read two places of the same book at once. Drag the divider to resize.
- Remembers the last page and zoom of every file, and reopens your panes on launch.
- **Contents** sidebar from the PDF's bookmarks, or detected automatically from headings when the PDF has none. Current section is highlighted.
- Highlight (several colours), underline, strike-through, pen and marker drawing, eraser, sticky notes, highlight + note.
- **Annotations are saved inside the PDF** as standard PDF annotations (visible in Acrobat, Preview, browsers) — saved automatically.
- Page thumbnails, bookmarks, Notes panel with Markdown export.
- Find (Ctrl+F), clickable internal links with Back/Forward (Alt+←/→), two-page spread, fit width / page. Pages stay centred until you scroll sideways.
- **Smart jump:** Alt+click / middle-click “Figure 3”, “(2.14)”, “Theorem 4.1”, “Table 2”, “Section 3.2” to preview it, even without links. Hover internal links to preview their target.
- Ctrl+P quick open of recent files; search in Contents and Notes.
- Snapshot a region to the clipboard, reading ruler, dark pages (inverted) for night reading, dark/light theme.

## Edit mode

- Add text (Unicode, incl. Cyrillic), images, rectangles, lines, arrows, whiteout.
- **Edit existing text**: click a line, it is covered and replaced with editable text in a matching size and colour.
- Signature pad (saved signatures), fill PDF forms.
- Pages: reorder by drag and drop, rotate, delete, insert blank page, insert another PDF, extract pages to a new file, crop margins.
- Edits stay movable until you **Save** (Ctrl+S), then they are written into the PDF. Save As keeps the original.
- LaTeX (full documents with live preview, LaTeX on pages) — in progress, only loaded in Edit mode.

## Other formats: DjVu, EPUB, FB2, CBZ, images

Open them like a PDF (Open, drag and drop, or Open With). PDF-Bat converts the file once into a PDF
next to the original (`book.djvu` → `book.pdf`) and opens that; opening the original again reuses it.

- **DjVu**: page images, decoded with [DjVu.js](https://github.com/RussCoder/djvujs) (GPL v2, in `src/djvujs`).
  Black-and-white pages stay 1-bit (sharp), colour pages keep DjVu's layers: background as JPEG,
  text as a full-resolution mask. The DjVu table of contents becomes PDF bookmarks.
- **EPUB, FB2**: laid out into pages by Chromium (any language, the book's own fonts and images),
  A5 pages, table of contents → bookmarks. Scripts and network access inside the book are blocked.
  DRM-protected books cannot be opened.
- **CBZ, JPG, PNG, WebP, GIF, BMP**: one page per image; several images selected together become one PDF.

## Updates

Windows installs updates automatically (downloaded in the background, installed on restart). macOS shows a notice with a one-click download of the new .dmg. *Help → Check for Updates…* checks manually.

## Shortcuts

| Read | | Edit | |
|---|---|---|---|
| V | select text | V | select / move objects |
| H | pan | R | edit existing text |
| A / U / S | highlight / underline / strike | T | text |
| P / M | pen / marker | L | LaTeX |
| E | eraser | I | image |
| N | sticky note | G | signature |
| X | snapshot | W / B / K / Q | whiteout / rectangle / line / arrow |
| B | bookmark page | Del | delete selected object |

Ctrl/Cmd: O open, P open recent, S save, Shift+S save as, J split same file side by side, W close pane, B sidebar, F find, Z/Shift+Z undo/redo, 1/2 Read/Edit mode, Shift+L theme.

## Development

```bash
npm install
npm start            # run the app
npm test             # end-to-end smoke test (Playwright + Electron)
npm run dist:mac     # build .dmg   (on macOS)
npm run dist:win     # build .exe   (on Windows)
```

Every push to `main` builds installers in GitHub Actions (downloadable from the run). Pushing a tag `vX.Y.Z` publishes a GitHub Release with the installers.

Stack: Electron, pdf.js (rendering, text layer), pdf-lib (writing annotations, page operations, edits), DejaVu fonts (bundled, for Unicode text).

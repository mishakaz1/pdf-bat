## PDF-Bat 0.3.0 — auto-update and smarter reading

**Updates**
- **Windows:** PDF-Bat now updates itself: new versions download in the background and install when you restart.
- **macOS:** PDF-Bat checks for new versions and offers a one-click download of the new .dmg (full self-update on Mac needs an Apple Developer signature).
- *Help → Check for Updates…* (on Mac: *PDF-Bat → Check for Updates…*). Install 0.3.0 manually once; after that it is automatic.

**Reading technical books**
- **Smart jump:** Alt+click (or middle-click) on “Figure 3”, “Eq. (2.14)”, “(2.14)”, “Theorem 4.1”, “Table 2”, “Section 3.2” → a preview of it pops up, even when the PDF has no links. Click the preview to go there, Alt+← to come back.
- **Link previews:** hover an internal link (contents, references, equations) to see where it leads without jumping.
- **Ctrl+P** (Cmd+P): quick open of recent files by typing part of the name.
- Search box in **Contents** and in **Notes** (finds text in highlights and notes).

### Install
- **Windows:** `PDF-Bat-Setup-0.3.0.exe`. SmartScreen may warn (not code-signed yet): *More info → Run anyway*.
- **macOS:** `arm64` .dmg for Apple Silicon, `x64` for Intel. Drag into Applications and replace the old version. First launch: right-click → *Open*; if macOS says it is damaged: `xattr -cr /Applications/PDF-Bat.app`.

## PDF-Bat 0.4.0

**Open DjVu, EPUB, FB2, CBZ and images.** They are turned into a PDF once, saved next to the original (`book.djvu` → `book.pdf`), and opened like any PDF: highlights, notes, bookmarks, split view all work. Opening the original again reuses the PDF.

- **DjVu**: pages are taken as images, so every language and every formula looks exactly like the original. Black-and-white pages stay razor-sharp 1-bit; colour pages keep DjVu's layers (sharp text over a compressed background). The DjVu table of contents becomes the sidebar Contents. A 70-page book converts in about 4 seconds.
- **EPUB / FB2**: laid out into A5 pages with the book's own fonts and pictures; chapters go into Contents. Old FB2 files in Windows-1251 encoding are read correctly.
- **CBZ / JPG / PNG / WebP**: one page per picture. Select several pictures at once to get one PDF.
- A progress window with Cancel during conversion.

Windows: 0.3.x updates itself. macOS: download the .dmg below.

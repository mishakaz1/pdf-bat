// Copies the runtime files we need from node_modules into src/vendor (run automatically after npm install).
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'src', 'vendor');
const nm = (p) => path.join(root, 'node_modules', p);
fs.rmSync(out, { recursive: true, force: true });
const copy = (from, to) => {
  const dst = path.join(out, to);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(nm(from), dst, { recursive: true });
};
copy('pdfjs-dist/build/pdf.mjs', 'pdfjs/pdf.mjs');
copy('pdfjs-dist/build/pdf.worker.mjs', 'pdfjs/pdf.worker.mjs');
copy('pdfjs-dist/web/pdf_viewer.css', 'pdfjs/pdf_viewer.css');
copy('pdfjs-dist/web/images', 'pdfjs/images');
copy('pdfjs-dist/cmaps', 'pdfjs/cmaps');
copy('pdfjs-dist/standard_fonts', 'pdfjs/standard_fonts');
copy('pdfjs-dist/LICENSE', 'pdfjs/LICENSE');
copy('pdf-lib/dist/pdf-lib.min.js', 'pdf-lib.min.js');
copy('pdf-lib/LICENSE.md', 'pdf-lib.LICENSE.md');
copy('@pdf-lib/fontkit/dist/fontkit.umd.min.js', 'fontkit.umd.min.js');
console.log('vendor files copied to src/vendor');

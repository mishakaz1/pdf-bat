// CI check: every built-in LaTeX template and snippet form compiles with a real engine.
// Usage: node test/latex-compile.mjs <engine-binary> <kind: tectonic|pdflatex|xelatex>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOC_TEMPLATES, snippetSource } from '../src/tex-templates.mjs';

const [bin = 'tectonic', kind = 'tectonic'] = process.argv.slice(2);
const cases = [
  ...DOC_TEMPLATES.map(t => [t.id, t.source(kind)]),
  ['snippet-math', snippetSource({ body: '\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt\\pi}{2}', kind })],
  ['snippet-text', snippetSource({ body: 'Energy $E = mc^2$ and \\textbf{bold}', mode: 'text', width: 200, kind })],
  ['snippet-cyrillic', snippetSource({ body: 'Сила $\\vec F = m\\vec a$ — другий закон Ньютона', mode: 'text', kind, color: '#1d4ed8' })],
  ['snippet-preamble', snippetSource({ body: '\\vb{F} = q\\vb{E}', preamble: '\\newcommand{\\vb}[1]{\\mathbf{#1}}', kind })]
];
let failed = 0;
for (const [name, src] of cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tex-'));
  const f = path.join(dir, 'doc.tex');
  fs.writeFileSync(f, src);
  try {
    const args = kind === 'tectonic' ? ['--outdir', dir, f] : ['-interaction=nonstopmode', '-halt-on-error', '-output-directory', dir, f];
    execFileSync(bin, args, { cwd: dir, stdio: 'pipe' });
    if (!fs.existsSync(path.join(dir, 'doc.pdf'))) throw new Error('no PDF produced');
    console.log('ok -', name);
  } catch (e) {
    failed++;
    console.log('FAIL -', name, '\n' + String(e.stdout || '') + String(e.stderr || e.message).slice(-3000));
  }
}
process.exit(failed ? 1 : 0);

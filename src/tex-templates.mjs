// LaTeX templates shared by the app and the CI compile test.

// kind: 'tectonic' | 'xelatex' | 'lualatex' | 'pdflatex'
export function unicodePreamble(kind) {
  if (kind === 'pdflatex') {
    return [
      '\\usepackage[T2A,T1]{fontenc}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage[ukrainian,english]{babel}'
    ].join('\n');
  }
  // XeTeX / LuaTeX: Computer Modern Unicode has Latin + Cyrillic + Greek and matches the math font
  return [
    '\\usepackage{fontspec}',
    '\\setmainfont{cmunrm.otf}[BoldFont=cmunbx.otf,ItalicFont=cmunti.otf,BoldItalicFont=cmunbi.otf]',
    '\\setsansfont{cmunss.otf}[BoldFont=cmunsx.otf,ItalicFont=cmunsi.otf,BoldItalicFont=cmunso.otf]',
    '\\setmonofont{cmuntt.otf}',
    '\\usepackage[ukrainian,english]{babel}'
  ].join('\n');
}

export const hasNonAscii = (s) => /[^\x00-\x7f]/.test(s);

// A LaTeX fragment placed onto a PDF page.
// mode: 'math' (display formula) | 'text' (paragraph that may contain $…$)
export function snippetSource({ body, mode = 'math', size = 12, color = '000000', width = 0, preamble = '', kind = 'tectonic' }) {
  const uni = hasNonAscii(body) ? unicodePreamble(kind) : '';
  const fontSize = `\\fontsize{${size}}{${(size * 1.2).toFixed(1)}}\\selectfont`;
  const content = mode === 'math'
    ? `$\\displaystyle ${body}$`
    : (width > 0 ? `\\begin{minipage}{${width}pt}\\raggedright ${body}\\end{minipage}` : body);
  return [
    '\\documentclass[border=1pt]{standalone}',
    uni,
    '\\usepackage{amsmath,amssymb,amsfonts,bm,xcolor}',
    preamble || '',
    '\\begin{document}',
    `\\color[HTML]{${color.replace('#', '').toUpperCase()}}${fontSize}%`,
    content,
    '\\end{document}',
    ''
  ].filter(l => l !== '').join('\n');
}

export const DOC_TEMPLATES = [
  {
    id: 'article',
    name: 'Article (English)',
    source: (kind) => String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[margin=2.5cm]{geometry}
\usepackage{amsmath,amssymb,bm}
\usepackage{graphicx}
\usepackage{siunitx}
\usepackage{hyperref}

\title{Title of the paper}
\author{Author}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
A short summary of the work.
\end{abstract}

\section{Introduction}
Newton's second law for a rigid body rotating about a fixed axis reads
\begin{equation}
  \tau = I \alpha, \qquad I = \int r^2 \, \mathrm{d}m .
  \label{eq:rot}
\end{equation}

\section{Results}
For a uniform rod of length $l$ pivoted at one end, $I = \tfrac{1}{3} m l^2$,
so Eq.~\eqref{eq:rot} gives $\alpha = \frac{3 g}{2 l}\sin\theta$.
A typical value is $g = \SI{9.81}{\metre\per\second\squared}$.

\end{document}
`
  },
  {
    id: 'article-uk',
    name: 'Стаття (українська)',
    source: (kind) => String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[margin=2.5cm]{geometry}
` + unicodePreamble(kind).replace('[ukrainian,english]', '[english,ukrainian]') + String.raw`
\usepackage{amsmath,amssymb,bm}
\usepackage{graphicx}
\usepackage{hyperref}

\title{Назва роботи}
\author{Автор}
\date{\today}

\begin{document}
\maketitle

\section{Вступ}
Другий закон Ньютона для обертального руху твердого тіла навколо нерухомої осі:
\begin{equation}
  \tau = I \alpha, \qquad I = \int r^2 \, \mathrm{d}m .
\end{equation}

\section{Результати}
Для однорідного стрижня довжиною $l$, закріпленого на кінці, $I = \tfrac{1}{3} m l^2$.

\end{document}
`
  },
  {
    id: 'solution',
    name: 'Problem solution',
    source: (kind) => String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[margin=2cm]{geometry}
\usepackage{amsmath,amssymb,bm}
\usepackage{enumitem}

\newcommand{\dd}{\mathrm{d}}

\begin{document}
\section*{Problem 1}
\textbf{Given:} \dots

\textbf{Solution.}
\begin{align}
  m \ddot{x} &= -k x \\
  \omega &= \sqrt{k/m}
\end{align}

\textbf{Answer:} $\omega = \sqrt{k/m}$.
\end{document}
`
  },
  {
    id: 'blank',
    name: 'Blank document',
    source: () => String.raw`\documentclass{article}
\usepackage{amsmath,amssymb}

\begin{document}

\end{document}
`
  }
];

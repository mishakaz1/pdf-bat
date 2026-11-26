import sys
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont('DV', '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'))
pdfmetrics.registerFont(TTFont('DVB', '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf'))
lorem = ("The motion of a rigid body can be decomposed into translation of the centre of mass and rotation about it. "
         "Consider a uniform rod of mass m and length l pivoted at one end; its moment of inertia is ml^2/3. ") * 3
def body(c, y, n=14):
    c.setFont('DV', 10.5)
    words = lorem.split()
    line = ''
    for w in words * 3:
        if c.stringWidth(line + ' ' + w, 'DV', 10.5) > 450:
            c.drawString(72, y, line); y -= 14; line = w; n -= 1
            if n == 0 or y < 80: break
        else: line = (line + ' ' + w).strip()
    return y
def book(path, bookmarks):
    c = canvas.Canvas(path, pagesize=A4)
    W, H = A4
    page = 0
    for ch in range(1, 6):
        c.setFont('DVB', 22); c.drawString(72, H-100, f'Chapter {ch}. Mechanics part {ch}')
        if bookmarks:
            c.bookmarkPage(f'ch{ch}'); c.addOutlineEntry(f'Chapter {ch}. Mechanics part {ch}', f'ch{ch}', level=0)
        y = body(c, H-140)
        for s in range(1, 4):
            for p in range(2):
                c.setFont('DV', 9); c.drawString(W/2-10, 40, str(page+1))
                c.drawString(72, H-40, 'Running header — Physics Book')
                if p == 0:
                    c.setFont('DVB', 15); c.drawString(72, H-160 if s==1 else H-100, f'{ch}.{s} Section about topic {s}')
                    if bookmarks:
                        c.bookmarkPage(f'ch{ch}s{s}'); c.addOutlineEntry(f'{ch}.{s} Section about topic {s}', f'ch{ch}s{s}', level=1)
                body(c, H-200 if s==1 else H-130, 40)
                if ch == 1 and s == 1 and p == 0:
                    c.setFont('DV', 10.5); c.drawString(72, 120, 'See Chapter 3 for details (internal link). Українська: рівняння руху.')
                    c.linkAbsolute('', 'ch3', (72, 115, 300, 132)) if bookmarks else None
                c.showPage(); page += 1
    c.save()
book(sys.argv[1] + '/book-bookmarks.pdf', True)
book(sys.argv[1] + '/book-plain.pdf', False)

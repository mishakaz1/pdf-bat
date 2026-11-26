# Builds small EPUB / FB2 / CBZ files for test/convert.js (run: python3 test/make_book_fixtures.py)
# The DjVu fixtures (spec.djvu, color.djvu) come from the DjVu.js test assets.
import base64, io, os, zipfile
from PIL import Image, ImageDraw
D = os.path.join(os.path.dirname(__file__), 'fixtures')

def png(text, size=(600, 800), color=(240, 200, 90)):
    im = Image.new('RGB', size, color); d = ImageDraw.Draw(im)
    d.rectangle([20, 20, size[0] - 20, size[1] - 20], outline=(0, 0, 0), width=6); d.text((60, 60), text, fill=(0, 0, 0))
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()

def jpg(text):
    im = Image.open(io.BytesIO(png(text))); b = io.BytesIO(); im.save(b, 'JPEG', quality=90); return b.getvalue()

# EPUB 3 with nav + NCX, Ukrainian and Greek text, an image, three chapters
chap = lambda t, body: f'''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="uk"><head><title>{t}</title><link rel="stylesheet" href="style.css"/></head>
<body><h1>{t}</h1>{body}</body></html>'''
para = '<p>' + 'Закон збереження енергії: повна механічна енергія замкненої системи стала. αβγ δ. ' * 12 + '</p>'
with zipfile.ZipFile(os.path.join(D, 'book.epub'), 'w') as z:
    z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip')
    z.writestr('META-INF/container.xml', '''<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>''', zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/content.opf', '''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="id">test-book</dc:identifier><dc:title>Тестова книга</dc:title><dc:creator>PDF-Bat</dc:creator><dc:language>uk</dc:language></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/><item id="c3" href="text/ch3.xhtml" media-type="application/xhtml+xml"/>
<item id="css" href="text/style.css" media-type="text/css"/><item id="img" href="images/fig.png" media-type="image/png"/></manifest>
<spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>''', zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/nav.xhtml', '''<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol><li><a href="text/ch1.xhtml">Розділ 1. Механіка</a><ol><li><a href="text/ch2.xhtml#s">Розділ 2. Коливання</a></li></ol></li><li><a href="text/ch3.xhtml">Розділ 3. Оптика</a></li></ol></nav></body></html>''', zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/toc.ncx', '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap/></ncx>', zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/text/style.css', 'h1{color:#336}', zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/images/fig.png', png('Figure 1'))
    z.writestr('OEBPS/text/ch1.xhtml', chap('Розділ 1. Механіка', para * 6), zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/text/ch2.xhtml', chap('Розділ 2. Коливання', '<p id="s">Рис. 1</p><p><img src="../images/fig.png" alt=""/></p>' + para * 2), zipfile.ZIP_DEFLATED)
    z.writestr('OEBPS/text/ch3.xhtml', chap('Розділ 3. Оптика', para * 3 + '<script>document.body.innerHTML="HACKED"</script><img src="https://example.com/x.png"/>'), zipfile.ZIP_DEFLATED)

# FB2 in windows-1251 with a cover image and two chapters
fb2 = f'''<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><author><first-name>Тарас</first-name><last-name>Шевченко</last-name></author><book-title>Кобзар (тест)</book-title><lang>uk</lang>
<coverpage><image l:href="#cover.jpg"/></coverpage></title-info></description>
<body><section><title><p>Перший розділ</p></title><p>Реве та стогне Дніпр широкий, сердитий вітер завива.</p><poem><stanza><v>Додолу верби гне високі,</v><v>Горами хвилю підійма.</v></stanza></poem></section>
<section><title><p>Другий розділ</p></title><section><title><p>Підрозділ</p></title><p>Текст підрозділу.</p></section></section></body>
<binary id="cover.jpg" content-type="image/jpeg">{base64.b64encode(jpg('Cover')).decode()}</binary></FictionBook>'''
open(os.path.join(D, 'book.fb2'), 'wb').write(fb2.encode('cp1251'))

with zipfile.ZipFile(os.path.join(D, 'comic.cbz'), 'w') as z:
    for i in [10, 2, 1]:  # natural order must be 1, 2, 10
        z.writestr(f'page{i}.png', png(f'Page {i}', color=(200, 220, 255)))
open(os.path.join(D, 'photo.jpg'), 'wb').write(jpg('Photo'))
open(os.path.join(D, 'scan.png'), 'wb').write(png('Scan', size=(800, 600)))

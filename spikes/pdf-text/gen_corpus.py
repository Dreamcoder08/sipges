#!/usr/bin/env python3
"""Builds the synthetic PDF corpus of the T57 spike. All text is invented.

Usage: gen_corpus.py <out-dir>  (needs reportlab, pikepdf; pdftoppm, gs, pdftocairo, qpdf, chrome-headless-shell)
"""
import io, os, random, subprocess, sys, zlib
from pathlib import Path

import pikepdf
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import (BaseDocTemplate, Frame, PageBreak, PageTemplate, Paragraph,
                                SimpleDocTemplate, Spacer, Table, TableStyle)

OUT = Path(sys.argv[1])
OUT.mkdir(parents=True, exist_ok=True)
CHROME = os.environ.get("CHROME") or str(next(Path.home().glob(
    ".cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell")))

SENTENCES = [
    "La asamblea de la comunidad campesina revisó el mandato de la junta directiva y su vigencia.",
    "Se registró una demanda de empleo local y una solicitud de capacitación para proveedores.",
    "El acta deja constancia del acuerdo y del plazo de seguimiento fijado por el responsable.",
    "Existe una controversia sobre la versión de los hechos; se pidió verificación de la fuente.",
    "La mesa de diálogo convocó una reunión de negociación con participación de las rondas.",
    "La inversión ofrece oportunidad de desarrollo, contratación de servicios y actividad productiva.",
    "Preocupa el impacto ambiental en el agua, el suelo y la salud del área de influencia.",
    "El señor Núñez, ingeniero de Piura, explicó el cronograma; ¿quién firmará el compromiso?",
    "¡Atención! La evidencia presentada en la denuncia no resuelve el cuestionamiento anterior.",
    "Los pingüinos de la bahía, según el informe, no dependen de la pesquería artesanal.",
]
rng = random.Random(57)
def para(n=4):
    return " ".join(rng.choice(SENTENCES) for _ in range(n))

STYLES = getSampleStyleSheet()
BODY = ParagraphStyle("body", parent=STYLES["BodyText"], fontName="Helvetica", fontSize=10.5, leading=14)
HEAD = ParagraphStyle("head", parent=STYLES["Heading1"], fontName="Helvetica-Bold")

def path(name): return str(OUT / f"{name}.pdf")

def flow(name, n=8, style=BODY, **kw):
    d = SimpleDocTemplate(path(name), pagesize=A4, **kw)
    s = [Paragraph("Acta de reunión territorial", HEAD)]
    s += [Paragraph(para(), style) for _ in range(n)]
    d.build(s)

def embedded(name):
    pdfmetrics.registerFont(TTFont("Serif", "/usr/share/fonts/noto/NotoSerif-Regular.ttf"))
    pdfmetrics.registerFont(TTFont("Sans", "/usr/share/fonts/noto/NotoSans-Regular.ttf"))
    flow(name, style=ParagraphStyle("e", parent=BODY, fontName="Serif"))

def justified(name):
    flow(name, style=ParagraphStyle("j", parent=BODY, alignment=4))

def inline_styles(name):
    txt = ("La <b>asamblea</b> de la <i>comunidad</i> aprobó el <u>acuerdo</u> con <font color='red'>"
           "plazo</font> de seguimiento<super>1</super> y un <b><i>responsable</i></b> designado por la "
           "junta. ") * 6
    d = SimpleDocTemplate(path(name), pagesize=A4)
    d.build([Paragraph(txt, BODY) for _ in range(4)])

def columns(name, ncols):
    d = BaseDocTemplate(path(name), pagesize=A4)
    w = (A4[0] - 3 * cm) / ncols
    frames = [Frame(1.5 * cm + i * w, 2 * cm, w - 6, A4[1] - 4 * cm) for i in range(ncols)]
    d.addPageTemplates([PageTemplate(id="c", frames=frames)])
    d.build([Paragraph(para(5), BODY) for _ in range(10)])

def table(name):
    d = SimpleDocTemplate(path(name), pagesize=landscape(A4))
    rows = [["Compromiso", "Responsable", "Plazo", "Estado"]]
    for i in range(14):
        rows.append([Paragraph(rng.choice(SENTENCES), BODY), f"Dirección de Gestión {i}",
                     f"{10 + i} de marzo de 2026", "En seguimiento"])
    t = Table(rows, colWidths=[12 * cm, 5 * cm, 4 * cm, 4 * cm], repeatRows=1)
    t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), .5, colors.grey), ("VALIGN", (0, 0), (-1, -1), "TOP")]))
    d.build([t])

def canvas_doc(name, draw, size=A4, pages=1):
    c = canvas.Canvas(path(name), pagesize=size)
    for p in range(pages):
        draw(c, p)
        c.showPage()
    c.save()

def rotated_text(c, p):
    c.setFont("Helvetica", 11)
    for i, s in enumerate(SENTENCES):
        c.saveState(); c.translate(80 + i * 24, 60); c.rotate(90); c.drawString(0, 0, s); c.restoreState()

def tilted_text(c, p):
    c.setFont("Helvetica", 11)
    c.saveState(); c.translate(90, 200); c.rotate(17)
    for i, s in enumerate(SENTENCES):
        c.drawString(0, -i * 16, s)
    c.restoreState()

def tiny_kerning(c, p):
    """Words in separate TJ-less strings with explicit positions, as office suites emit."""
    c.setFont("Helvetica", 11)
    y = 780
    for s in SENTENCES:
        x = 60
        for w in s.split():
            c.drawString(x, y, w)
            x += c.stringWidth(w, "Helvetica", 11) + c.stringWidth(" ", "Helvetica", 11)
            if x > 480:
                x = 60; y -= 15
        y -= 15

def letterspaced(c, p):
    t = c.beginText(60, 780); t.setFont("Helvetica", 11); t.setCharSpace(1.4)
    for s in SENTENCES:
        t.textLine(s)
    c.drawText(t)

def wordspaced(c, p):
    t = c.beginText(60, 780); t.setFont("Helvetica", 11); t.setWordSpace(6)
    for s in SENTENCES:
        t.textLine(s)
    c.drawText(t)

def invisible(c, p):
    t = c.beginText(60, 780); t.setFont("Helvetica", 11); t.setTextRenderMode(3)
    for s in SENTENCES:
        t.textLine(s)
    c.drawText(t)

def hyphen(c, p):
    c.setFont("Helvetica", 11)
    lines = ["La represen-", "tatividad de la asam-", "blea fue objeto de cuestio-", "namiento por la comu-",
             "nidad y se pidió verifica-", "ción de la fuente. El proce-", "so continúa."]
    for i, s in enumerate(lines):
        c.drawString(60, 780 - i * 15, s)

def header_footer(c, p):
    c.setFont("Helvetica", 8); c.drawString(60, 810, "Sistema de gestión social · Documento de trabajo")
    c.drawRightString(535, 30, f"Página {p + 1} de 3")
    c.setFont("Helvetica", 11)
    y = 770
    for s in rng.sample(SENTENCES, 6):
        c.drawString(60, y, s[:70]); y -= 15; c.drawString(60, y, s[70:]); y -= 22

def out_of_order(c, p):
    """Content stream draws the bottom of the page first: only sorted extractors notice."""
    c.setFont("Helvetica", 11)
    for i, s in reversed(list(enumerate(SENTENCES))):
        c.drawString(60, 760 - i * 18, s)

def form_annot(c, p):
    c.setFont("Helvetica", 11); c.drawString(60, 780, SENTENCES[0])
    c.acroForm.textfield(name="acta", value=SENTENCES[1], x=60, y=700, width=460, height=24)
    c.linkURL("https://example.org/", (60, 770, 300, 790))
    c.bookmarkPage("p0"); c.addOutlineEntry("Acta de reunión", "p0")

def type3():
    """A hand-built Type 3 font with a ToUnicode-less Encoding: ASCII names only."""
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(595, 842))
    glyph = pdf.make_stream(b"500 0 0 0 400 600 d1 0 0 400 600 re f")
    charprocs = pikepdf.Dictionary()
    diffs = pikepdf.Array([32, pikepdf.Name("/space"), 97])
    for ch in "abcdefghijklmnopqrstuvwxyz":
        diffs.append(pikepdf.Name("/" + ch)); charprocs["/" + ch] = glyph
    charprocs["/space"] = glyph
    font = pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type3, FontBBox=[0, 0, 500, 700],
        FontMatrix=[.001, 0, 0, .001, 0, 0], CharProcs=charprocs,
        Encoding=pikepdf.Dictionary(Type=pikepdf.Name.Encoding, Differences=diffs),
        FirstChar=32, LastChar=122, Widths=[500] * 91)
    page = pdf.pages[0]
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=pdf.make_indirect(font)))
    page.Contents = pdf.make_stream(b"BT /F1 12 Tf 60 780 Td 14 TL (la asamblea de la comunidad aprobo el acuerdo) Tj T* (con plazo y responsable de seguimiento) Tj ET")
    pdf.save(path("11-type3-font"))

def nfd():
    c = canvas.Canvas(path("12-accents-winansi"), pagesize=A4)
    c.setFont("Helvetica", 11)
    y = 790
    for s in ["áéíóú ÁÉÍÓÚ ñÑ üÜ ¿¡ º ª € « » – — “ ” ‘ ’ … • ·", "Elección, petición, versión, diálogo, área de influencia, reunión.", "Señora Muñoz: preocupación por la negociación y la verificación ambiental."]:
        c.drawString(60, y, s); y -= 18
    c.showPage(); c.save()

def scanned(name, source, dpi=120):
    subprocess.run(["pdftoppm", "-r", str(dpi), "-png", path(source), str(OUT / f"_{name}")], check=True)
    pngs = sorted(OUT.glob(f"_{name}*.png"))
    c = canvas.Canvas(path(name), pagesize=A4)
    for png in pngs:
        c.drawImage(str(png), 0, 0, A4[0], A4[1]); c.showPage()
    c.save()
    for png in pngs: png.unlink()

def scanned_with_ocr_layer():
    """An image page with an invisible text layer, the shape ocrmypdf writes."""
    scanned("31-scan-for-layer", "01-plain-helvetica")
    src = pikepdf.open(path("31-scan-for-layer"))
    buf = io.BytesIO(); c = canvas.Canvas(buf, pagesize=A4); invisible(c, 0); c.save(); buf.seek(0)
    layer = pikepdf.open(buf)
    src.pages[0].add_overlay(layer.pages[0])
    src.save(path("32-scan-with-text-layer")); src.close()
    Path(path("31-scan-for-layer")).unlink()

def chrome(name, html, tagged=True):
    h = OUT / f"_{name}.html"
    h.write_text(html, encoding="utf-8")
    args = [CHROME, "--headless", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
            f"--print-to-pdf={path(name)}", h.as_uri()]
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    h.unlink()

CSS = "<meta charset=utf-8><style>body{font:11pt 'Noto Serif',serif;margin:2cm}td,th{border:1px solid #888;padding:4px}table{border-collapse:collapse}</style>"
def html_p(n): return "".join(f"<p>{para()}</p>" for _ in range(n))

def chrome_docs():
    chrome("20-chrome-tagged", f"{CSS}<h1>Acta de reunión</h1>{html_p(6)}<h2>Acuerdos</h2><ul><li>{SENTENCES[2]}</li><li>{SENTENCES[4]}</li></ul>{html_p(3)}")
    chrome("21-chrome-columns", f"{CSS}<div style='columns:2;column-gap:1cm;text-align:justify'>{html_p(9)}</div>")
    rows = "".join(f"<tr><td>{rng.choice(SENTENCES)}</td><td>Oficina {i}</td><td>{i + 1}/03/2026</td></tr>" for i in range(16))
    chrome("22-chrome-table", f"{CSS}<table><tr><th>Compromiso</th><th>Responsable</th><th>Plazo</th></tr>{rows}</table>")
    chrome("23-chrome-sans-ligatures", "<meta charset=utf-8><style>body{font:12pt 'Noto Sans',sans-serif;margin:2cm;font-feature-settings:'liga' 1}</style>" + "<p>La oficina de planificación definió la fiabilidad del flujo y la verificación final de la confirmación.</p>" + html_p(4))
    chrome("24-chrome-rtl-mix", f"{CSS}<p>{SENTENCES[0]} <span dir=rtl>שלום עולם</span> {SENTENCES[2]}</p>")

def gs_rewrite(src, name, *extra):
    subprocess.run(["gs", "-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=pdfwrite", *extra, f"-sOutputFile={path(name)}", path(src)], check=True)

def cairo_rewrite(src, name):
    subprocess.run(["pdftocairo", "-pdf", path(src), path(name)], check=True)

def qpdf(src, name, *args):
    subprocess.run(["qpdf", *args, path(src), path(name)], check=True)

def rotate_page(src, name, angle):
    p = pikepdf.open(path(src))
    for page in p.pages: page.Rotate = angle
    p.save(path(name)); p.close()

def malformed():
    good = Path(path("01-plain-helvetica")).read_bytes()
    (OUT / "60-bad-not-a-pdf.pdf").write_bytes(b"MZ not a pdf at all")
    (OUT / "61-bad-header-only.pdf").write_bytes(b"%PDF-1.7\n")
    (OUT / "62-bad-truncated-half.pdf").write_bytes(good[: len(good) // 2])
    (OUT / "63-bad-truncated-tail.pdf").write_bytes(good[:-120])
    i = good.find(b"xref")
    (OUT / "64-bad-no-xref.pdf").write_bytes(good[:i] + good[i + 4:].replace(b"startxref", b"startxxxx"))
    corrupt = bytearray(good)
    j = good.find(b"stream") + 40
    corrupt[j:j + 60] = bytes(rng.randrange(256) for _ in range(60))
    (OUT / "65-bad-corrupt-stream.pdf").write_bytes(corrupt)
    (OUT / "66-bad-random-bytes.pdf").write_bytes(b"%PDF-1.4\n" + bytes(rng.randrange(256) for _ in range(4000)))
    # A page tree that points to itself.
    loop = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[2 0 R]/Count 1>>endobj\n"
            b"trailer<</Root 1 0 R>>\n")
    (OUT / "67-bad-page-tree-loop.pdf").write_bytes(loop)
    # /Count lies about the page count.
    lie = (b"%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 99999>>endobj\n"
           b"3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n")
    (OUT / "68-bad-count-lie.pdf").write_bytes(lie)

def large():
    def body(c, p):
        c.setFont("Helvetica", 10)
        y = 800
        for k in range(50):
            c.drawString(50, y, rng.choice(SENTENCES)); y -= 15
    canvas_doc("70-large-100-pages", body, pages=100)
    canvas_doc("71-large-101-pages", body, pages=101)
    # 18 MB of incompressible image plus text: the upload limit shape, not the page limit.
    c = canvas.Canvas(path("72-large-image-heavy"), pagesize=A4)
    w, h = 2450, 2450
    raw = zlib.compress(random.Random(1).randbytes(w * h * 3), 1)
    c.setFont("Helvetica", 11); c.drawString(60, 780, SENTENCES[0]); c.showPage(); c.save()
    p = pikepdf.open(path("72-large-image-heavy"), allow_overwriting_input=True)
    img = p.make_stream(raw, Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Image, Width=w, Height=h,
                        ColorSpace=pikepdf.Name.DeviceRGB, BitsPerComponent=8, Filter=pikepdf.Name.FlateDecode)
    page = p.pages[0]
    page.Resources.XObject = pikepdf.Dictionary(Im0=img)
    page.contents_add(b" q 100 0 0 100 0 0 cm /Im0 Do Q", prepend=False)
    p.save(path("72-large-image-heavy")); p.close()

flow("01-plain-helvetica")
embedded("02-embedded-ttf-noto")
justified("03-justified")
inline_styles("04-inline-styles")
columns("05-two-columns", 2)
columns("06-three-columns", 3)
table("07-table-grid")
canvas_doc("08-hyphen-breaks", hyphen)
canvas_doc("09-header-footer", header_footer, pages=3)
canvas_doc("10-out-of-order", out_of_order)
type3()
nfd()
canvas_doc("13-word-by-word", tiny_kerning)
canvas_doc("14-letter-spaced", letterspaced)
canvas_doc("15-word-spaced", wordspaced)
canvas_doc("16-invisible-render-mode", invisible)
canvas_doc("17-form-and-link", form_annot)
canvas_doc("18-text-rotated-90", rotated_text)
canvas_doc("19-text-tilted-17", tilted_text)
chrome_docs()
for a, n in [(90, "25-page-rotate-90"), (180, "26-page-rotate-180"), (270, "27-page-rotate-270")]:
    rotate_page("01-plain-helvetica", n, a)
scanned("30-scanned-image-only", "01-plain-helvetica")
scanned_with_ocr_layer()
gs_rewrite("20-chrome-tagged", "40-gs-rewrite-chrome")
gs_rewrite("01-plain-helvetica", "41-gs-rewrite-pdfa", "-dPDFA=2", "-dPDFACompatibilityPolicy=1")
cairo_rewrite("20-chrome-tagged", "42-cairo-rewrite-chrome")
cairo_rewrite("05-two-columns", "43-cairo-rewrite-columns")
qpdf("01-plain-helvetica", "44-object-streams", "--object-streams=generate")
qpdf("20-chrome-tagged", "45-linearized", "--linearize")
qpdf("01-plain-helvetica", "50-encrypted-user-password", "--encrypt", "clave", "dueno", "256", "--")
qpdf("01-plain-helvetica", "51-encrypted-owner-only-aes256", "--encrypt", "", "dueno", "256", "--")
qpdf("01-plain-helvetica", "52-encrypted-owner-only-rc4", "--allow-weak-crypto", "--encrypt", "", "dueno", "128", "--use-aes=n", "--")
qpdf("20-chrome-tagged", "53-encrypted-owner-only-aes128", "--encrypt", "", "dueno", "128", "--use-aes=y", "--")
malformed()
large()
print(len(list(OUT.glob("*.pdf"))), "files")

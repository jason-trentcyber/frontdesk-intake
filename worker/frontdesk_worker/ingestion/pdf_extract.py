"""PDF text-layer extraction (ADR-0005: "PDFs are text-extracted then
treated as Markdown"). Text-layer only - no OCR, matching the ADR's scope;
a scanned/image-only PDF yields an empty or near-empty string, which the
chunker then correctly turns into zero or one near-empty chunk rather than
raising.

Library: pypdf. Pure Python, and on Python >=3.11 (this project's floor)
it has no mandatory dependency at all per its own package metadata -
checked directly against 6.18.1's release metadata rather than assumed.
The realistic alternatives were pdfminer.six (heavier API for the same
text-layer-only need) and PyMuPDF (fast and high quality, but AGPL/
commercial dual-licensed - the wrong fit pulled into an Apache-2.0 repo,
and its compiled MuPDF binary is exactly the "large transitive tree" this
image's 512Mi limit can't absorb for a component that isn't the embedder).

Extracted page text is joined with a blank line between pages, since pypdf
does not preserve original paragraph/heading structure - the chunker's
markdown-awareness (headings, fences) still applies to whatever structure
survives extraction, same as the ADR's "then treated as Markdown" says, but
a PDF with no Markdown syntax in its text layer chunks as one heading-less
document, which is correct, not a bug.
"""

from io import BytesIO

from pypdf import PdfReader


def extract_pdf_text(raw: bytes) -> str:
    reader = PdfReader(BytesIO(raw))
    pages = [page.extract_text() or "" for page in reader.pages]
    return "\n\n".join(p.strip() for p in pages if p.strip())

from frontdesk_worker.ingestion.pdf_extract import extract_pdf_text


def _make_pdf(page_texts: list[str]) -> bytes:
    """Hand-built minimal PDF (no reportlab dependency just for tests) - one
    page per string, each a single BT/Tj text object. pypdf tolerates the
    simplified xref table below (recovers by scanning objects directly,
    same as it would for a real-world PDF with a damaged xref).
    """
    objects: list[bytes] = []
    kids = " ".join(f"{3 + i} 0 R" for i in range(len(page_texts)))
    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    objects.append(f"<< /Type /Pages /Kids [{kids}] /Count {len(page_texts)} >>".encode())

    font_obj_num = 3 + len(page_texts)
    content_obj_nums: list[int] = []
    for i, text in enumerate(page_texts):
        content_num = font_obj_num + 1 + i
        content_obj_nums.append(content_num)
        objects.append(
            f"<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 {font_obj_num} 0 R >> >> "
            f"/MediaBox [0 0 612 792] /Contents {content_num} 0 R >>".encode()
        )
    objects.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    for text in page_texts:
        escaped = text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        stream = f"BT /F1 24 Tf 72 712 Td ({escaped}) Tj ET".encode()
        objects.append(f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream")

    body = b"%PDF-1.4\n"
    for i, obj in enumerate(objects, start=1):
        body += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    body += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n0\n%%EOF".encode()
    return body


def test_extracts_text_from_a_single_page() -> None:
    pdf = _make_pdf(["Hello World"])

    assert extract_pdf_text(pdf) == "Hello World"


def test_extracts_and_joins_text_from_multiple_pages() -> None:
    pdf = _make_pdf(["Page one text", "Page two text"])

    text = extract_pdf_text(pdf)

    assert "Page one text" in text
    assert "Page two text" in text
    assert text.index("Page one text") < text.index("Page two text")


def test_image_only_pdf_with_no_text_layer_returns_empty_string() -> None:
    pdf = _make_pdf([""])

    assert extract_pdf_text(pdf) == ""

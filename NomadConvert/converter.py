"""Offline conversion engine: never makes network calls."""
from __future__ import annotations

import csv
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps, ImageSequence

IMAGE_EXT = {"png", "jpg", "jpeg", "webp", "bmp", "tiff", "tif", "gif", "ico"}
VIDEO_EXT = {"mp4", "webm", "mov", "mkv", "avi", "m4v", "wmv", "flv"}
AUDIO_EXT = {"mp3", "wav", "flac", "ogg", "opus", "m4a", "aac", "wma"}
DOC_EXT = {"pdf", "docx", "txt", "odt", "pptx"}
DATA_EXT = {"csv", "tsv", "xlsx", "json"}
IMAGE_TARGETS = ["png", "jpg", "webp", "bmp", "tiff", "gif", "ico", "pdf"]
VIDEO_TARGETS = ["mp4", "webm", "mov", "mkv", "avi", "gif", "mp3", "wav"]
AUDIO_TARGETS = ["mp3", "wav", "flac", "ogg", "opus", "m4a", "aac"]
DATA_TARGETS = ["csv", "tsv", "xlsx", "json"]


def canonical(ext: str) -> str:
    ext = ext.lower().lstrip(".")
    return {"jpeg": "jpg", "tif": "tiff"}.get(ext, ext)


def capabilities() -> dict[str, Any]:
    ffmpeg = bool(shutil.which("ffmpeg"))
    libreoffice = bool(shutil.which("libreoffice"))
    inputs: dict[str, list[str]] = {}
    for ext in IMAGE_EXT:
        inputs[ext] = IMAGE_TARGETS.copy()
    for ext in VIDEO_EXT:
        inputs[ext] = VIDEO_TARGETS.copy() if ffmpeg else []
    for ext in AUDIO_EXT:
        inputs[ext] = AUDIO_TARGETS.copy() if ffmpeg else []
    inputs["pdf"] = ["txt", "png", "jpg"]
    inputs["docx"] = ["txt", "pdf"] if libreoffice else ["txt"]
    inputs["txt"] = ["pdf", "docx"]
    inputs["odt"] = ["pdf"] if libreoffice else []
    inputs["pptx"] = ["pdf"] if libreoffice else []
    for ext in DATA_EXT:
        inputs[ext] = DATA_TARGETS.copy()
    for ext, targets in inputs.items():
        inputs[ext] = [out for out in targets if canonical(ext) != out]
    categories = {
        "image": {"name": "Изображения", "inputs": sorted(IMAGE_EXT)},
        "video": {"name": "Видео", "inputs": sorted(VIDEO_EXT)},
        "audio": {"name": "Аудио", "inputs": sorted(AUDIO_EXT)},
        "document": {"name": "Документы", "inputs": sorted(DOC_EXT)},
        "table": {"name": "Таблицы", "inputs": sorted(DATA_EXT)},
    }
    return {"inputs": inputs, "categories": categories,
            "dependencies": {"ffmpeg": ffmpeg, "libreoffice": libreoffice},
            "input_count": len([x for x, opts in inputs.items() if opts]),
            "offline": True}


def convert(src: Path, target: str, outdir: Path, quality: int = 85) -> Path:
    ext = src.suffix.lower().lstrip(".")
    target = canonical(target)
    options = capabilities()["inputs"].get(ext, [])
    if target not in options:
        raise ValueError(f"Конвертация {ext.upper()} → {target.upper()} не поддерживается или не установлен нужный компонент.")
    clean_name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", src.stem).strip(" .")[:90] or "converted"
    dest = outdir / f"{clean_name}.{target}"
    if ext in IMAGE_EXT:
        _image(src, dest, target, quality)
    elif ext in VIDEO_EXT or ext in AUDIO_EXT:
        _media(src, dest, target)
    elif ext in DATA_EXT:
        _table(src, dest, target)
    elif ext == "pdf":
        if target == "txt":
            _pdf_text(src, dest)
        else:
            dest = _pdf_images(src, outdir, clean_name, target)
    elif ext == "docx" and target == "txt":
        _docx_text(src, dest)
    elif ext == "txt":
        _text_document(src, dest, target)
    elif target == "pdf" and ext in {"docx", "odt", "pptx"}:
        _libreoffice_pdf(src, dest)
    else:
        raise ValueError("Этот тип конвертации недоступен")
    if not dest.is_file() or dest.stat().st_size == 0:
        raise RuntimeError("Не удалось создать выходной файл")
    return dest


def _image(src: Path, dest: Path, target: str, quality: int) -> None:
    with Image.open(src) as original:
        im = ImageOps.exif_transpose(original)
        if getattr(im, "is_animated", False):
            im.seek(0)
        im.load()
        if target in {"jpg", "bmp", "pdf"}:
            if im.mode in {"RGBA", "LA"} or "transparency" in im.info:
                rgba = im.convert("RGBA")
                background = Image.new("RGB", rgba.size, "#FFFFFF")
                background.paste(rgba, mask=rgba.getchannel("A"))
                im = background
            else:
                im = im.convert("RGB")
        elif target == "ico":
            im = im.convert("RGBA")
            im.thumbnail((256, 256))
        elif target == "gif":
            im = im.convert("RGBA")
        elif target == "webp" and im.mode not in {"RGB", "RGBA"}:
            im = im.convert("RGBA")
        elif target == "png" and im.mode not in {"RGB", "RGBA", "L", "LA", "P"}:
            im = im.convert("RGBA")
        elif target == "tiff" and im.mode not in {"RGB", "RGBA", "L"}:
            im = im.convert("RGB")
        save_format = {"jpg": "JPEG", "png": "PNG", "tiff": "TIFF", "ico": "ICO", "pdf": "PDF"}.get(target, target.upper())
        kwargs: dict[str, Any] = {}
        if target in {"jpg", "webp"}:
            kwargs["quality"] = quality
        if target == "jpg":
            kwargs.update(optimize=True, progressive=True)
        if target == "png":
            kwargs["optimize"] = True
        im.save(dest, format=save_format, **kwargs)


def _run(cmd: list[str], timeout: int = 1200) -> None:
    try:
        result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Время конвертации истекло") from exc
    if result.returncode != 0:
        explanation = (result.stderr or result.stdout).strip().splitlines()
        short = explanation[-1] if explanation else "Неизвестная ошибка"
        raise RuntimeError("Ошибка конвертации: " + short[:240])


def _media(src: Path, dest: Path, target: str) -> None:
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", str(src)]
    if target in AUDIO_TARGETS:
        cmd += ["-vn", "-map", "0:a:0"]
        codec = {
            "mp3": ["-c:a", "libmp3lame", "-q:a", "3"],
            "wav": ["-c:a", "pcm_s16le"],
            "flac": ["-c:a", "flac"],
            "ogg": ["-c:a", "libvorbis", "-q:a", "5"],
            "opus": ["-c:a", "libopus", "-b:a", "128k"],
            "m4a": ["-c:a", "aac", "-b:a", "192k"],
            "aac": ["-c:a", "aac", "-b:a", "192k"],
        }
        cmd += codec[target]
    elif target == "gif":
        cmd += ["-map", "0:v:0", "-vf", "fps=12,scale=540:-1:flags=lanczos", "-loop", "0"]
    else:
        cmd += ["-map", "0:v:0", "-map", "0:a?", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"]
        if target == "webm":
            cmd += ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "5",
                    "-b:v", "0", "-crf", "34", "-c:a", "libopus", "-b:a", "128k"]
        elif target == "avi":
            cmd += ["-c:v", "mpeg4", "-q:v", "5", "-c:a", "libmp3lame", "-q:a", "4"]
        else:
            cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "160k"]
            if target in {"mp4", "mov"}:
                cmd += ["-movflags", "+faststart"]
    cmd += [str(dest)]
    _run(cmd)


def _pdf_text(src: Path, dest: Path) -> None:
    from pypdf import PdfReader
    reader = PdfReader(str(src))
    if reader.is_encrypted:
        raise ValueError("PDF защищён паролем")
    text = "\n\n".join(page.extract_text() or "" for page in reader.pages)
    if not text.strip():
        raise ValueError("В PDF нет текстового слоя. Для сканированных страниц потребуется OCR.")
    dest.write_text(text, encoding="utf-8")


def _pdf_images(src: Path, outdir: Path, stem: str, fmt: str) -> Path:
    import fitz
    doc = fitz.open(src)
    if doc.needs_pass:
        raise ValueError("PDF защищён паролем")
    if doc.page_count == 0:
        raise ValueError("В PDF нет страниц")
    # Render at ~144 DPI, avoids enormous output for typical print pages.
    if doc.page_count == 1:
        dest = outdir / f"{stem}.{fmt}"
        pix = doc[0].get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
        pix.save(str(dest)) if fmt == "png" else _pix_jpg(pix, dest)
        doc.close()
        return dest
    dest = outdir / f"{stem}_pages_{fmt}.zip"
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as archive:
        for i, page in enumerate(doc):
            pix = page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False)
            if fmt == "png":
                data = pix.tobytes("png")
            else:
                data = pix.tobytes("jpeg")
            archive.writestr(f"{stem}_page_{i + 1:03}.{fmt}", data)
    doc.close()
    return dest


def _pix_jpg(pix: Any, dest: Path) -> None:
    dest.write_bytes(pix.tobytes("jpeg"))


def _docx_text(src: Path, dest: Path) -> None:
    from docx import Document
    doc = Document(str(src))
    lines = [p.text for p in doc.paragraphs]
    for table in doc.tables:
        for row in table.rows:
            lines.append("\t".join(cell.text for cell in row.cells))
    dest.write_text("\n".join(lines), encoding="utf-8")


def _read_text(src: Path) -> str:
    raw = src.read_bytes()
    for encoding in ["utf-8-sig", "utf-16", "cp1251"]:
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    raise ValueError("Не удалось определить кодировку текста")


def _text_document(src: Path, dest: Path, target: str) -> None:
    content = _read_text(src)
    if target == "docx":
        from docx import Document
        doc = Document()
        for line in content.splitlines():
            doc.add_paragraph(line)
        doc.save(dest)
        return
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.utils import simpleSplit
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas
    font_path = next((x for x in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
    ] if os.path.isfile(x)), None)
    if not font_path:
        raise RuntimeError("Для PDF нужен шрифт DejaVu Sans или Liberation Sans")
    if "LocalConvertText" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("LocalConvertText", font_path))
    page = canvas.Canvas(str(dest), pagesize=A4)
    w, h = A4
    x, y = 48, h - 50
    page.setFont("LocalConvertText", 10)
    for line in content.splitlines():
        wrapped = simpleSplit(line, "LocalConvertText", 10, w - 96) or [""]
        for piece in wrapped:
            if y < 48:
                page.showPage()
                page.setFont("LocalConvertText", 10)
                y = h - 50
            page.drawString(x, y, piece)
            y -= 15
    page.save()


def _libreoffice_pdf(src: Path, dest: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="localconvert_lo_") as profile:
        _run(["libreoffice", "-env:UserInstallation=" + Path(profile).as_uri(),
              "--headless", "--convert-to", "pdf", "--outdir", str(dest.parent), str(src)], timeout=180)
    produced = src.with_suffix(".pdf")
    if produced != dest and produced.is_file():
        shutil.move(produced, dest)
    if not dest.exists():
        raise RuntimeError("LibreOffice не создал PDF")


def _table(src: Path, dest: Path, target: str) -> None:
    ext = src.suffix.lower().lstrip(".")
    if ext == "xlsx":
        from openpyxl import load_workbook
        book = load_workbook(src, read_only=True, data_only=True)
        try:
            sheet = book.active
            values = list(sheet.values)
            headers = [str(cell) if cell is not None else f"column_{i+1}" for i, cell in enumerate(values[0])] if values else []
            rows = [dict(zip(headers, ["" if c is None else c for c in row])) for row in values[1:]]
        finally:
            book.close()
    elif ext == "json":
        obj = json.loads(_read_text(src))
        if isinstance(obj, dict) and isinstance(obj.get("rows"), list):
            obj = obj["rows"]
        if not isinstance(obj, list) or any(not isinstance(row, dict) for row in obj):
            raise ValueError('JSON должен быть массивом объектов: [{"name":"..."}]')
        rows = obj
    else:
        raw = _read_text(src)
        delimiter = "\t" if ext == "tsv" else ","
        if ext == "csv":
            try:
                delimiter = csv.Sniffer().sniff(raw[:8192], delimiters=",;\t|").delimiter
            except csv.Error:
                pass
        rows = list(csv.DictReader(io.StringIO(raw), delimiter=delimiter))
    if target == "json":
        dest.write_text(json.dumps(rows, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
        return
    headers = list(dict.fromkeys(key for row in rows for key in row))
    if ext in {"csv", "tsv"} and not rows:
        raw = _read_text(src).strip()
        delim = "\t" if ext == "tsv" else ","
        if raw:
            headers = next(csv.reader(io.StringIO(raw), delimiter=delim), [])
    if target == "xlsx":
        from openpyxl import Workbook
        book = Workbook()
        sheet = book.active
        sheet.title = "Данные"
        if headers:
            sheet.append(headers)
        for row in rows:
            sheet.append([_scalar(row.get(key)) for key in headers])
        sheet.freeze_panes = "A2"
        if headers:
            from openpyxl.styles import Font, PatternFill
            for cell in sheet[1]:
                cell.font = Font(bold=True, color="FFFFFF")
                cell.fill = PatternFill("solid", fgColor="262626")
            from openpyxl.utils import get_column_letter
            for i, key in enumerate(headers[:100], 1):
                sheet.column_dimensions[get_column_letter(i)].width = min(45, max(13, len(key) + 5))
        book.save(dest)
    else:
        with dest.open("w", encoding="utf-8-sig", newline="") as fp:
            writer = csv.DictWriter(fp, fieldnames=headers, delimiter="\t" if target == "tsv" else ",", extrasaction="ignore")
            writer.writeheader()
            for row in rows:
                writer.writerow({key: _scalar(row.get(key)) for key in headers})


def _scalar(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False)
    return value


def merge_pdfs(files: list[Path], dest: Path) -> None:
    from pypdf import PdfReader, PdfWriter
    writer = PdfWriter()
    try:
        for path in files:
            reader = PdfReader(path)
            if reader.is_encrypted:
                raise ValueError("Один из PDF защищён паролем")
            writer.append(reader)
        if len(writer.pages) == 0:
            raise ValueError("В загруженных PDF нет страниц")
        with dest.open("wb") as f:
            writer.write(f)
    finally:
        writer.close()


def zip_files(files: list[tuple[Path, str]], dest: Path) -> None:
    with zipfile.ZipFile(dest, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        used = set()
        for i, (src, original) in enumerate(files, 1):
            name = Path(original).name or f"file_{i}"
            while name in used:
                name = f"{i}_{name}"
            used.add(name)
            archive.write(src, arcname=name)

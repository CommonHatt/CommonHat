"""Nomad Convert — local-only Flask server. Bind strictly to 127.0.0.1."""
from __future__ import annotations

import mimetypes
import os
import re
import shutil
import time
import uuid
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.utils import secure_filename

from converter import capabilities, canonical, convert, merge_pdfs, zip_files

app = Flask(__name__)
app.json.ensure_ascii = False
app.config["MAX_CONTENT_LENGTH"] = 800 * 1024 * 1024
CACHE = Path(os.environ.get("NOMAD_CONVERT_CACHE", Path.home() / ".cache" / "nomad-convert" / "jobs"))
CACHE.mkdir(parents=True, exist_ok=True)
TTL_SECONDS = 6 * 60 * 60


def cleanup() -> None:
    now = time.time()
    for folder in CACHE.iterdir():
        if folder.is_dir() and now - folder.stat().st_mtime > TTL_SECONDS:
            shutil.rmtree(folder, ignore_errors=True)


def make_job() -> tuple[str, Path]:
    cleanup()
    job_id = uuid.uuid4().hex
    folder = CACHE / job_id
    folder.mkdir(parents=True)
    return job_id, folder


def bad(message: str, status: int = 400):
    return jsonify({"error": message}), status


def job_response(job_id: str, output: Path):
    return jsonify({
        "id": job_id,
        "name": output.name,
        "bytes": output.stat().st_size,
        "extension": output.suffix.lstrip(".").lower(),
        "download": f"/api/download/{job_id}",
    })


def handle_error(exc: Exception):
    if isinstance(exc, ValueError):
        return bad(str(exc))
    app.logger.exception("Conversion error")
    return bad(str(exc)[:350] or "Ошибка преобразования", 500)


@app.errorhandler(RequestEntityTooLarge)
def too_big(exc):
    return bad("Файл слишком большой. Максимум — 800 МБ.", 413)


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/capabilities")
def api_capabilities():
    data = capabilities()
    data["max_bytes"] = app.config["MAX_CONTENT_LENGTH"]
    return jsonify(data)


@app.post("/api/convert")
def api_convert():
    upload = request.files.get("file")
    if not upload or not upload.filename:
        return bad("Выбери файл для конвертации")
    suffix = Path(upload.filename).suffix.lower()
    if not suffix or len(suffix) > 9:
        return bad("Не удалось определить расширение файла")
    target = canonical(request.form.get("target", ""))
    allowed = capabilities()["inputs"].get(suffix.lstrip("."), [])
    if target not in allowed:
        return bad("Эта конвертация недоступна. Проверь выбранный формат.")
    try:
        quality = max(25, min(100, int(request.form.get("quality", "85"))))
    except ValueError:
        return bad("Некорректное качество изображения")
    job_id, folder = make_job()
    try:
        original_stem = Path(upload.filename).stem
        stem = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", original_stem).strip(" .")[:90] or "file"
        infile = folder / (stem + suffix)
        upload.save(infile)
        if not infile.stat().st_size:
            raise ValueError("Файл пустой")
        output = convert(infile, target, folder, quality)
        infile.unlink(missing_ok=True)
        return job_response(job_id, output)
    except Exception as exc:
        shutil.rmtree(folder, ignore_errors=True)
        return handle_error(exc)


@app.post("/api/merge-pdf")
def api_merge_pdf():
    uploads = [x for x in request.files.getlist("files") if x.filename]
    if len(uploads) < 2:
        return bad("Выбери минимум два PDF-файла")
    if len(uploads) > 30:
        return bad("Максимум 30 PDF за один раз")
    if any(Path(x.filename).suffix.lower() != ".pdf" for x in uploads):
        return bad("Для объединения нужны только PDF-файлы")
    job_id, folder = make_job()
    try:
        sources = []
        for i, up in enumerate(uploads):
            src = folder / f"part_{i + 1:03}.pdf"
            up.save(src)
            sources.append(src)
        output = folder / "merged.pdf"
        merge_pdfs(sources, output)
        for src in sources:
            src.unlink(missing_ok=True)
        return job_response(job_id, output)
    except Exception as exc:
        shutil.rmtree(folder, ignore_errors=True)
        return handle_error(exc)


@app.post("/api/zip")
def api_zip():
    uploads = [x for x in request.files.getlist("files") if x.filename]
    if not uploads:
        return bad("Добавь хотя бы один файл")
    if len(uploads) > 60:
        return bad("Максимум 60 файлов в архиве")
    job_id, folder = make_job()
    try:
        sources = []
        for i, up in enumerate(uploads):
            src = folder / f"item_{i + 1:03}.bin"
            up.save(src)
            sources.append((src, up.filename))
        output = folder / "files.zip"
        zip_files(sources, output)
        for src, _ in sources:
            src.unlink(missing_ok=True)
        return job_response(job_id, output)
    except Exception as exc:
        shutil.rmtree(folder, ignore_errors=True)
        return handle_error(exc)


@app.get("/api/download/<job_id>")
def download(job_id: str):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        return bad("Неверный идентификатор", 404)
    folder = CACHE / job_id
    if not folder.is_dir():
        return bad("Файл не найден или уже очищен", 404)
    outputs = [x for x in folder.iterdir() if x.is_file()]
    if len(outputs) != 1:
        return bad("Файл ещё не готов", 404)
    return send_file(outputs[0], as_attachment=True, download_name=outputs[0].name,
                     mimetype=mimetypes.guess_type(outputs[0].name)[0] or "application/octet-stream")


@app.delete("/api/jobs/<job_id>")
def delete_job(job_id: str):
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        return bad("Неверный идентификатор", 404)
    shutil.rmtree(CACHE / job_id, ignore_errors=True)
    return jsonify({"ok": True})


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "mode": "local", "internet_required": False})


if __name__ == "__main__":
    cleanup()
    print("\n  Nomad Convert: http://127.0.0.1:8765\n  Ctrl+C — остановить сервер\n", flush=True)
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", "8765")), debug=False, threaded=True)

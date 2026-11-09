#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo 'Ошибка: нужен Python 3. Установите: sudo apt install python3 python3-venv'
  exit 1
fi

if [ ! -d .venv ]; then
  echo '[1/3] Создание локального Python-окружения...'
  python3 -m venv .venv || { echo 'Установите: sudo apt install python3-venv'; exit 1; }
fi

if ! .venv/bin/python -c 'import flask, PIL, pypdf, fitz, docx, reportlab, openpyxl' >/dev/null 2>&1; then
  echo '[2/3] Разовая установка зависимостей (нужен интернет только для установки)...'
  .venv/bin/python -m pip install -r requirements.txt
fi

echo '[3/3] Запуск локального сайта...'
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo 'Подсказка: для видео и аудио установите sudo apt install ffmpeg'
fi
if ! command -v libreoffice >/dev/null 2>&1; then
  echo 'Подсказка: для DOCX → PDF установите sudo apt install libreoffice-writer'
fi
(sleep 2; xdg-open 'http://127.0.0.1:8765' >/dev/null 2>&1 || true) &
exec .venv/bin/python app.py

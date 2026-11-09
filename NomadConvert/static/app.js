(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = {caps: null, files: [], toolFiles: [], tool: 'pdf', category: 'all', busy: false, results: [], preferredTarget: null};
  const fmt = (n) => n < 1024 ? `${n} Б` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} КБ` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} МБ` : `${(n / 1024 ** 3).toFixed(2)} ГБ`;
  const ext = file => (file.name.split('.').pop() || '').toLowerCase();
  const icon = (id) => `<svg aria-hidden="true"><use href="#i-${id}"></use></svg>`;
  let toastTimer;

  function toast(message) {
    const bar = $('toast');
    bar.textContent = message;
    bar.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => bar.classList.remove('show'), 3500);
  }
  function errorIn(target, message) {
    target.textContent = message;
    target.hidden = !message;
  }
  function scrollToId(id) { $(id).scrollIntoView({behavior: 'smooth', block: 'start'}); }

  function toggleDrawer(open) {
    $('drawer').classList.toggle('open', open);
    $('drawer-backdrop').classList.toggle('visible', open);
    document.body.style.overflow = open ? 'hidden' : '';
  }
  $('menu-open').addEventListener('click', () => toggleDrawer(true));
  $('drawer-close').addEventListener('click', () => toggleDrawer(false));
  $('drawer-backdrop').addEventListener('click', () => toggleDrawer(false));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleDrawer(false); });
  document.querySelectorAll('[data-nav]').forEach(button => button.addEventListener('click', () => {
    toggleDrawer(false);
    const nav = button.dataset.nav;
    document.querySelectorAll('[data-nav]').forEach(el => el.classList.toggle('active', el === button));
    if (nav === 'pdf' || nav === 'zip') selectTool(nav);
    scrollToId(nav === 'convert' ? 'converter' : nav === 'history' ? 'history' : 'tools');
  }));

  async function init() {
    try {
      const response = await fetch('/api/capabilities');
      if (!response.ok) throw new Error('Не удалось проверить локальный сервер');
      state.caps = await response.json();
      $('formats-count').textContent = String(state.caps.input_count);
      const missing = [];
      if (!state.caps.dependencies.ffmpeg) missing.push('Для видео и аудио установи ffmpeg: sudo apt install ffmpeg');
      if (!state.caps.dependencies.libreoffice) missing.push('Для DOCX → PDF установи LibreOffice: sudo apt install libreoffice-writer');
      if (missing.length) {
        $('dependency-notice').hidden = false;
        $('dependency-notice').textContent = missing.join(' · ');
      }
      updateAccept();
    } catch (e) {
      errorIn($('convert-error'), 'Нет соединения с локальным сервером. Запусти ./start.sh и открой http://127.0.0.1:8765');
    }
  }

  const categoryMap = {all: null, video: 'video', image: 'image', audio: 'audio', document: 'document', table: 'table'};
  function chooseCategory(category) {
    state.category = category;
    document.querySelectorAll('[data-category]').forEach(button => button.classList.toggle('active', button.dataset.category === category));
    updateAccept();
  }
  function updateAccept() {
    if (!state.caps) return;
    const chosen = categoryMap[state.category];
    const allowed = chosen ? state.caps.categories[chosen].inputs : Object.keys(state.caps.inputs);
    $('file-picker').accept = allowed.map(x => `.${x}`).join(',');
  }
  document.querySelectorAll('[data-category]').forEach(button => button.addEventListener('click', () => chooseCategory(button.dataset.category)));
  function openPicker() { $('file-picker').click(); }
  $('select-files').addEventListener('click', e => { e.stopPropagation(); openPicker(); });
  const zone = $('dropzone');
  zone.addEventListener('click', (e) => { if (!e.target.closest('#select-files')) openPicker(); });
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); } });
  for (const event of ['dragenter', 'dragover']) zone.addEventListener(event, e => {e.preventDefault();zone.classList.add('dragover');});
  for (const event of ['dragleave', 'drop']) zone.addEventListener(event, e => {e.preventDefault();zone.classList.remove('dragover');});
  zone.addEventListener('drop', e => { if (e.dataTransfer.files.length) setFiles([...e.dataTransfer.files]); });
  $('file-picker').addEventListener('change', e => { if (e.target.files.length) setFiles([...e.target.files]); e.target.value = ''; });

  function listFiles(element, files, onRemove) {
    element.replaceChildren();
    files.forEach((file, i) => {
      const row = document.createElement('div');row.className = 'file-row';
      const badge = document.createElement('span');badge.className = 'file-ext';badge.textContent = ext(file).slice(0, 6).toUpperCase() || 'FILE';
      const meta = document.createElement('div');meta.className = 'file-meta';
      const name = document.createElement('span');name.className = 'file-name';name.textContent = file.name;
      const size = document.createElement('span');size.className = 'file-size';size.textContent = fmt(file.size);
      meta.append(name, size);
      const remove = document.createElement('button');remove.className = 'file-remove';remove.type = 'button';remove.setAttribute('aria-label', `Удалить ${file.name}`);remove.innerHTML = icon('x');remove.addEventListener('click', onRemove.bind(null, i));
      row.append(badge, meta, remove);element.appendChild(row);
    });
  }

  function setFiles(files) {
    if (state.busy || !state.caps) return;
    if (files.some(x => x.size > state.caps.max_bytes)) {
      errorIn($('convert-error'), 'Размер каждого файла должен быть не больше 800 МБ.');
      return;
    }
    state.files = files;
    listFiles($('file-list'), files, i => {state.files.splice(i, 1);refreshFileChoices();});
    refreshFileChoices();
  }
  function availableTargets() {
    if (!state.caps || !state.files.length) return [];
    const groups = state.files.map(f => state.caps.inputs[ext(f)] || []);
    return groups[0].filter(output => groups.every(options => options.includes(output)));
  }
  function refreshFileChoices() {
    listFiles($('file-list'), state.files, i => {state.files.splice(i, 1);refreshFileChoices();});
    const select = $('target-format');
    const old = state.preferredTarget || select.value;
    select.replaceChildren();
    const available = availableTargets();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = !state.files.length ? 'Сначала выбери файл' : !available.length ? 'Нет общего формата для этих файлов' : 'Выбери формат';
    select.appendChild(placeholder);
    for (const target of available) {
      const option = document.createElement('option');
      option.value = target;option.textContent = `${target.toUpperCase()} — ${describeFormat(target)}`;
      select.appendChild(option);
    }
    select.disabled = !available.length;
    const preferred = preferredFor(state.files[0]);
    const selected = [old, preferred, available[0]].find(x => available.includes(x));
    if (selected) select.value = selected;
    if (state.files.length && !available.length) errorIn($('convert-error'), 'Выбраны несовместимые типы файлов. Для пакетной конвертации выбери файлы одной категории.');
    else errorIn($('convert-error'), '');
    state.preferredTarget = null;
    refreshConvertButton();
  }
  function preferredFor(file) {
    if (!file) return '';
    return {webm:'mp4',mkv:'mp4',mov:'mp4',avi:'mp4',mp4:'webm',jpg:'png',jpeg:'png',png:'jpg',gif:'webp',webp:'png',pdf:'txt',docx:'pdf',txt:'pdf',mp3:'wav',wav:'mp3',flac:'mp3',ogg:'mp3',json:'xlsx',csv:'xlsx',tsv:'xlsx',xlsx:'csv'}[ext(file)] || '';
  }
  function describeFormat(name) {
    return ({mp4:'универсальное видео',webm:'видео для веба',mov:'видео QuickTime',mkv:'видеоконтейнер',avi:'видео AVI',gif:'анимация / изображение',mp3:'сжатое аудио',wav:'аудио без сжатия',flac:'аудио без потерь',m4a:'аудио AAC',aac:'аудио AAC',ogg:'аудио OGG',opus:'аудио Opus',png:'изображение без потерь',jpg:'фотография JPEG',webp:'компактное изображение',bmp:'изображение BMP',tiff:'изображение TIFF',ico:'иконка',pdf:'документ PDF',txt:'обычный текст',docx:'документ Word',xlsx:'таблица Excel',csv:'таблица CSV',tsv:'таблица TSV',json:'структурированные данные'})[name] || name.toUpperCase();
  }
  function refreshConvertButton() {
    const target = $('target-format').value;
    $('convert-btn').disabled = state.busy || !state.files.length || !target;
    const quality = ['jpg','webp'].includes(target) && state.files.length && ['png','jpg','jpeg','webp','bmp','gif','tiff','tif','ico'].includes(ext(state.files[0]));
    $('quality-row').hidden = !quality;
    $('quality-range').hidden = !quality;
  }
  $('target-format').addEventListener('change', () => {state.preferredTarget = null;refreshConvertButton();});
  $('quality-range').addEventListener('input', e => $('quality-value').textContent = `${e.target.value}%`);

  function activatePreset(from, to) {
    if (!state.caps) return;
    if (state.files.length && state.files.every(f => (state.caps.inputs[ext(f)] || []).includes(to))) {
      $('target-format').value = to;refreshConvertButton();toast(`Выбран формат ${to.toUpperCase()}`);
    } else {
      chooseCategory('all');
      state.preferredTarget = to;
      $('file-picker').accept = `.${from}`;
      openPicker();
    }
    scrollToId('converter');
  }
  document.querySelectorAll('[data-from][data-to]').forEach(button => button.addEventListener('click', () => activatePreset(button.dataset.from, button.dataset.to)));
  $('tip-preset').addEventListener('click', () => activatePreset('webm', 'mp4'));

  function addResult(data) {
    state.results.unshift(data);
    $('empty-history').hidden = true;$('clear-results').hidden = false;
    const row = document.createElement('div');row.className = 'result-row';
    const resultIcon = document.createElement('div');resultIcon.className = 'result-icon';resultIcon.innerHTML = icon('check');
    const meta = document.createElement('div');meta.className = 'result-meta';
    const name = document.createElement('strong');name.textContent = data.name;
    const sub = document.createElement('span');sub.textContent = `${fmt(data.bytes)} · Готово к скачиванию`;
    meta.append(name,sub);
    const a = document.createElement('a');a.className = 'download-action';a.href = data.download;a.download = data.name;a.setAttribute('aria-label',`Скачать ${data.name}`);a.innerHTML = icon('download');
    row.append(resultIcon,meta,a);$('result-list').prepend(row);
  }
  function setBusy(busy, tool = false) {
    state.busy = busy;
    if (tool) {
      $('tool-processing').hidden = !busy;
      $('tool-action').disabled = busy || state.toolFiles.length < (state.tool === 'pdf' ? 2 : 1);
      $('tool-choose').disabled = busy;
    } else {
      $('processing').hidden = !busy;
      refreshConvertButton();
      $('select-files').disabled = busy;
    }
  }
  async function postForm(path, form) {
    let res;
    try { res = await fetch(path, {method: 'POST', body: form}); }
    catch {throw new Error('Нет соединения с локальным сервером');}
    let data;
    try {data = await res.json();} catch {throw new Error('Не удалось прочитать ответ сервера');}
    if (!res.ok) throw new Error(data.error || `Ошибка ${res.status}`);
    return data;
  }
  $('convert-btn').addEventListener('click', async () => {
    if (state.busy || !state.files.length || !$('target-format').value) return;
    const output = $('target-format').value;
    const queued = [...state.files];
    errorIn($('convert-error'), '');setBusy(true);
    let successes = 0;const failures = [];
    for (let i = 0; i < queued.length; i++) {
      const file = queued[i];
      $('processing-text').textContent = `${i+1}/${queued.length} · ${file.name} · Конвертация...`;
      const form = new FormData();form.append('file', file);form.append('target', output);form.append('quality', $('quality-range').value);
      try {addResult(await postForm('/api/convert', form));successes++;}
      catch(e) {failures.push(`${file.name}: ${e.message}`);}
    }
    setBusy(false);
    if (failures.length) errorIn($('convert-error'), failures.slice(0,3).join(' · '));
    if (successes) {toast(`Готово: ${successes} файл(ов)`);scrollToId('history');}
  });

  function selectTool(tool) {
    if (state.busy || !['pdf','zip'].includes(tool)) return;
    state.tool = tool;
    state.toolFiles = [];
    document.querySelectorAll('[data-tool]').forEach(button => button.classList.toggle('active',button.dataset.tool === tool));
    $('tool-title').textContent = tool === 'pdf' ? 'Объединение PDF' : 'Архивирование ZIP';
    $('tool-subtitle').textContent = tool === 'pdf' ? 'Выбери 2 или более PDF в нужном порядке.' : 'Добавь файлы любых типов для упаковки в ZIP.';
    $('tool-type-pill').textContent = tool === 'pdf' ? 'PDF' : 'ZIP';
    $('tool-action').innerHTML = `Создать ${tool === 'pdf' ? 'PDF' : 'ZIP'} ${icon('arrow-right')}`;
    $('tool-picker').accept = tool === 'pdf' ? '.pdf' : '';
    $('tool-file-list').replaceChildren();
    $('tool-action').disabled = true;
    errorIn($('tool-error'), '');
  }
  document.querySelectorAll('[data-tool]').forEach(button => button.addEventListener('click', () => selectTool(button.dataset.tool)));
  $('tool-choose').addEventListener('click', () => $('tool-picker').click());
  $('tool-picker').addEventListener('change', e => {
    if (!e.target.files.length || state.busy) return;
    const chosen = [...e.target.files];
    if (state.tool === 'pdf' && chosen.some(f => ext(f) !== 'pdf')) {errorIn($('tool-error'), 'Добавлять можно только PDF.');return;}
    if (chosen.some(f => f.size > 800*1024*1024)) {errorIn($('tool-error'), 'Размер файла превышает 800 МБ.');return;}
    state.toolFiles.push(...chosen);
    e.target.value = '';
    refreshToolFiles();
  });
  function refreshToolFiles() {
    listFiles($('tool-file-list'), state.toolFiles, i => {state.toolFiles.splice(i, 1);refreshToolFiles();});
    $('tool-action').disabled = state.busy || state.toolFiles.length < (state.tool === 'pdf' ? 2 : 1);
    errorIn($('tool-error'), '');
  }
  $('tool-action').addEventListener('click', async () => {
    if (state.busy || !state.toolFiles.length) return;
    const tool = state.tool;
    const form = new FormData();
    state.toolFiles.forEach(file => form.append('files',file));
    errorIn($('tool-error'), '');setBusy(true,true);
    $('tool-processing-text').textContent = tool === 'pdf' ? 'Объединяем страницы PDF...' : 'Собираем архив ZIP...';
    try {
      const data = await postForm(tool === 'pdf' ? '/api/merge-pdf' : '/api/zip', form);
      addResult(data);toast('Файл готов!');scrollToId('history');
    } catch(e) {errorIn($('tool-error'),e.message);}
    finally {setBusy(false,true);}
  });
  $('clear-results').addEventListener('click', async () => {
    const results = [...state.results];
    state.results = [];$('result-list').replaceChildren();$('empty-history').hidden = false;$('clear-results').hidden = true;
    await Promise.allSettled(results.map(r => fetch(`/api/jobs/${r.id}`, {method: 'DELETE'})));
    toast('Список очищен, временные файлы удалены');
  });

  init();
})();

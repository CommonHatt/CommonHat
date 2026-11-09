import fs from 'node:fs';
import path from 'node:path';
import {promises as fsp} from 'node:fs';
import {spawn, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import os from 'node:os';
import {zipFiles} from './zip.js';

const IMG = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tiff', 'tif', 'gif', 'ico'];
const VID = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'wmv', 'flv'];
const AUD = ['mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'wma'];
const DOC = ['pdf', 'docx', 'txt', 'odt', 'pptx'];
const DATA = ['csv', 'tsv', 'json', 'xlsx'];
const IOUT = ['png', 'jpg', 'webp', 'bmp', 'tiff', 'gif', 'ico'];
const VOUT = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'gif', 'mp3', 'wav'];
const AOUT = ['mp3', 'wav', 'flac', 'ogg', 'opus', 'm4a', 'aac'];
const check = name => {
  try {return spawnSync('which', [name], {stdio:'ignore', timeout:1000}).status === 0;}
  catch {return false;}
};
export function capabilities() {
  const ffmpeg = check('ffmpeg');
  const imagemagick = check('magick') || check('convert');
  const libreoffice = check('libreoffice');
  const pdftotext = check('pdftotext');
  const pdftoppm = check('pdftoppm');
  const pdfunite = check('pdfunite');
  const inputs = {};
  for (const ext of IMG) inputs[ext] = [...(imagemagick || ffmpeg ? IOUT : []), ...(libreoffice ? ['pdf'] : [])];
  for (const ext of VID) inputs[ext] = ffmpeg ? [...VOUT] : [];
  for (const ext of AUD) inputs[ext] = ffmpeg ? [...AOUT] : [];
  inputs.pdf = [...(pdftotext ? ['txt'] : []), ...(pdftoppm ? ['png', 'jpg'] : [])];
  inputs.docx = libreoffice ? ['txt', 'pdf'] : [];
  inputs.txt = libreoffice ? ['pdf', 'docx'] : [];
  inputs.odt = libreoffice ? ['pdf'] : [];
  inputs.pptx = libreoffice ? ['pdf'] : [];
  for (const ext of DATA) inputs[ext] = DATA.filter(x => (x !== 'xlsx' && ext !== 'xlsx') || libreoffice);
  for (const [ext, targets] of Object.entries(inputs)) inputs[ext] = targets.filter(x => canonical(ext) !== x);
  const category = (name, arr) => ({name, inputs:arr.filter(x => inputs[x]?.length)});
  return {
    inputs,
    categories: {
      image:category('Изображения', IMG), video:category('Видео', VID),
      audio:category('Аудио', AUD), document:category('Документы', DOC),
      table:category('Таблицы', DATA),
    },
    dependencies:{ffmpeg, imagemagick, libreoffice, pdftotext, pdftoppm, pdfunite},
    input_count:Object.values(inputs).filter(x => x.length).length,
    max_bytes:800 * 1024 * 1024,
    offline:true,
  };
}
export const canonical = name => ({jpeg:'jpg', tif:'tiff'}[String(name).toLowerCase().replace(/^\./,'')] || String(name).toLowerCase().replace(/^\./,''));

async function run(executable, args, {timeout = 20 * 60 * 1000, cwd} = {}) {
  return await new Promise((resolve, reject) => {
    const p = spawn(executable, args, {cwd, stdio:['ignore','pipe','pipe']});
    let stderr = '', stdout = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, timeout);
    p.stdout.on('data', part => {stdout = (stdout + part.toString()).slice(-5000);});
    p.stderr.on('data', part => {stderr = (stderr + part.toString()).slice(-5000);});
    p.on('error', error => {clearTimeout(timer); reject(new Error(`${executable}: ${error.message}`));});
    p.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Время конвертации истекло'));
      if (code !== 0) {
        const detail = (stderr || stdout).trim().split('\n').slice(-2).join(' ').slice(-300);
        reject(new Error(`Ошибка конвертации: ${detail || executable + ' завершился с кодом ' + code}`));
      } else resolve({stdout,stderr});
    });
  });
}
function safeStem(src) {
  return path.parse(src).name.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/^\.+/,'').slice(0,90) || 'converted';
}
async function ensureOutput(destination) {
  if (!(await fsp.stat(destination).catch(()=>null))?.size) throw new Error('Выходной файл не был создан');
  return destination;
}
async function loConvert(src, extension, destDir) {
  const profile = await fsp.mkdtemp(path.join(os.tmpdir(),'nomad-lo-'));
  try {
    await run('libreoffice', [
      '-env:UserInstallation='+pathToFileURL(profile).href,
      '--headless','--convert-to', extension, '--outdir',destDir,src
    ], {timeout:180_000});
    return path.join(destDir,`${safeStem(src)}.${extension.split(':')[0]}`);
  } finally {await fsp.rm(profile,{recursive:true,force:true});}
}
async function imageConvert(src, dest, ext, target, quality) {
  if (target === 'pdf') {
    // LibreOffice Draw imports common raster formats and exports them to PDF.
    const produced = await loConvert(src,'pdf',path.dirname(dest));
    return await ensureOutput(produced);
  }
  if (check('magick') || check('convert')) {
    const cmd = check('magick') ? 'magick' : 'convert';
    const args = [`${src}[0]`, '-auto-orient'];
    if (target === 'jpg' || target === 'bmp') args.push('-background','#ffffff','-alpha','remove','-alpha','off');
    if (target === 'ico') args.push('-resize','256x256>');
    if (['jpg','webp'].includes(target)) args.push('-quality',String(quality));
    args.push(dest);
    await run(cmd,args);
  } else {
    const args = ['-hide_banner','-loglevel','error','-nostdin','-y','-i',src,'-frames:v','1'];
    if (target === 'jpg') args.push('-q:v',String(Math.max(2,Math.min(25,Math.round((105-quality)/4)))));
    args.push(dest);
    await run('ffmpeg',args);
  }
  return await ensureOutput(dest);
}
async function mediaConvert(src, dest, target) {
  const args = ['-hide_banner','-loglevel','error','-nostdin','-y','-i',src];
  if (AOUT.includes(target)) {
    const codecs = {
      mp3:['-c:a','libmp3lame','-q:a','3'], wav:['-c:a','pcm_s16le'],
      flac:['-c:a','flac'], ogg:['-c:a','libvorbis','-q:a','5'],
      opus:['-c:a','libopus','-b:a','128k'], m4a:['-c:a','aac','-b:a','192k'],
      aac:['-c:a','aac','-b:a','192k'],
    };
    args.push('-vn','-map','0:a:0', ...codecs[target]);
  } else if (target === 'gif') {
    args.push('-map','0:v:0','-vf','fps=12,scale=540:-2:flags=lanczos','-loop','0');
  } else {
    args.push('-map','0:v:0','-map','0:a?','-vf','scale=trunc(iw/2)*2:trunc(ih/2)*2');
    if (target === 'webm') args.push('-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','5','-b:v','0','-crf','34','-c:a','libopus','-b:a','128k');
    else if (target === 'avi') args.push('-c:v','mpeg4','-q:v','5','-c:a','libmp3lame','-q:a','4');
    else {
      args.push('-c:v','libx264','-preset','veryfast','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','160k');
      if (['mp4','mov'].includes(target)) args.push('-movflags','+faststart');
    }
  }
  args.push(dest);
  await run('ffmpeg', args);
  return await ensureOutput(dest);
}
async function pdfConvert(src, dest, target, folder, stem) {
  if (target === 'txt') {
    await run('pdftotext',['-layout','-enc','UTF-8',src,dest]);
    const value = await fsp.readFile(dest,'utf8').catch(()=>'');
    if (!value.trim()) throw new Error('В PDF нет текста. Для отсканированных страниц нужен OCR.');
    return dest;
  }
  const prefix = path.join(folder,'page');
  await run('pdftoppm',['-f','1','-r','144',target === 'png' ? '-png' : '-jpeg',src,prefix]);
  const matching = (await fsp.readdir(folder)).filter(x => x.startsWith('page-') && x.endsWith(target === 'png' ? '.png':'.jpg')).sort();
  if (!matching.length) throw new Error('Не удалось получить изображение из PDF');
  if (matching.length === 1) {
    await fsp.rename(path.join(folder,matching[0]),dest);
    return dest;
  }
  const zipDest = path.join(folder,`${stem}_pages_${target}.zip`);
  await zipFiles(matching.map((file, index) => ({path:path.join(folder,file),name:`${stem}_page_${String(index+1).padStart(3,'0')}.${target}`})),zipDest);
  await Promise.all(matching.map(file => fsp.rm(path.join(folder,file),{force:true})));
  return zipDest;
}
function splitRows(csv, delimiter) {
  const rows=[]; let cell='', row=[], quoting=false;
  for (let i=0; i<csv.length; i++) {
    const char=csv[i];
    if (char==='"') {
      if (quoting && csv[i+1]==='"') {cell+='"';i++;}
      else quoting=!quoting;
    } else if (char===delimiter && !quoting) {row.push(cell);cell='';}
    else if ((char==='\n'||char==='\r') && !quoting) {
      if (char==='\r' && csv[i+1]==='\n') i++;
      row.push(cell);if(row.some(x=>x!==''))rows.push(row);row=[];cell='';
    } else cell+=char;
  }
  if (quoting) throw new Error('Незакрытые кавычки в CSV');
  if (cell!=='' || row.length) {row.push(cell);rows.push(row);}
  return rows;
}
function detectDelimiter(s) {
  const line=s.split(/\r?\n/,1)[0];
  return [',',';','\t','|'].sort((a,b)=>line.split(b).length - line.split(a).length)[0];
}
function parseCSV(text, sep) {
  const rows=splitRows(text.replace(/^\uFEFF/,''),sep);
  if(!rows.length)return [];
  const headers=rows[0].map((x,i)=>x||`column_${i+1}`);
  return rows.slice(1).map(row=>Object.fromEntries(headers.map((x,i)=>[x,row[i]??''])));
}
function makeCSV(rows,sep) {
  const keys=[...new Set(rows.flatMap(x=>Object.keys(x)))];
  const escape=x=>{const value=(x===null||x===undefined?'':typeof x==='object'?JSON.stringify(x):String(x));return /[\r\n"]/.test(value) || value.includes(sep) ? '"'+value.replaceAll('"','""')+'"':value;};
  return '\uFEFF'+[keys.map(escape).join(sep),...rows.map(row=>keys.map(key=>escape(row[key])).join(sep))].join('\r\n')+'\r\n';
}
async function dataConvert(src,dest,ext,target,folder) {
  let rows;
  let txtPath=src;
  if (ext==='xlsx') {
    txtPath=await loConvert(src,'csv',folder);
    await ensureOutput(txtPath);
  }
  if (ext==='json') {
    try {rows=JSON.parse((await fsp.readFile(src,'utf8')).replace(/^\uFEFF/,''));}
    catch {throw new Error('Некорректный JSON');}
    if (Array.isArray(rows?.rows)) rows=rows.rows;
    if (!Array.isArray(rows) || rows.some(x=>!x||typeof x!=='object'||Array.isArray(x))) throw new Error('JSON должен содержать массив объектов');
  } else {
    const csv=await fsp.readFile(txtPath,'utf8');
    rows=parseCSV(csv,ext==='tsv'?'\t':detectDelimiter(csv));
  }
  if (target === 'json') {await fsp.writeFile(dest,JSON.stringify(rows,null,2),'utf8');return dest;}
  if (target === 'csv'||target==='tsv') {await fsp.writeFile(dest,makeCSV(rows,target==='tsv'?'\t':','));return dest;}
  const intermediate=path.join(folder,`${safeStem(src)}-intermediate.csv`);
  await fsp.writeFile(intermediate,makeCSV(rows,','));
  const result = await loConvert(intermediate,'xlsx',folder);
  if (result!==dest) await fsp.rename(result,dest);
  return await ensureOutput(dest);
}
export async function convert(src,target,folder,quality=85) {
  const ext=path.extname(src).toLowerCase().slice(1);
  target=canonical(target);
  if (!capabilities().inputs[ext]?.includes(target)) throw new Error(`Конвертация ${ext.toUpperCase()} → ${target.toUpperCase()} недоступна`);
  const stem=safeStem(src), dest=path.join(folder,`${stem}.${target}`);
  let out;
  if (IMG.includes(ext)) out=await imageConvert(src,dest,ext,target,quality);
  else if ([...VID,...AUD].includes(ext)) out=await mediaConvert(src,dest,target);
  else if (ext==='pdf') out=await pdfConvert(src,dest,target,folder,stem);
  else if (DATA.includes(ext)) out=await dataConvert(src,dest,ext,target,folder);
  else if (DOC.includes(ext)) {
    const loTarget = target === 'txt' ? 'txt:Text' : target;
    out=await loConvert(src,loTarget,folder);
  } else throw new Error('Неподдерживаемый тип файла');
  return await ensureOutput(out);
}
export async function mergePDFs(sources,dest) {
  if (!check('pdfunite')) throw new Error('Установи poppler-utils: sudo apt install poppler-utils');
  await run('pdfunite',[...sources,dest]);
  return await ensureOutput(dest);
}

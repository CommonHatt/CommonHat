/** Nomad Convert: zero-dependency local HTTP API for Ubuntu. No cloud uploads. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {promises as fsp} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {Transform} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {capabilities, canonical, convert, mergePDFs} from './converter.js';
import {zipFiles} from './zip.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const TMP = path.join(ROOT,'.cache');
const JOBS = path.join(TMP,'jobs');
const UPLOADS = path.join(TMP,'uploads');
const PORT = Number(process.env.PORT || 8765);
const MAX_BYTES = 800 * 1024 * 1024;
const TTL_MS = 6 * 60 * 60 * 1000;
const MAX_JSON = 32 * 1024;
const uploads = new Map();
for (const p of [JOBS,UPLOADS]) await fsp.mkdir(p,{recursive:true});

function validId(s) {return /^[a-f\d]{32}$/.test(s || '');}
function fileName(original) {
  let value=String(original||'').replaceAll('\\','/').split('/').pop().replace(/[\x00-\x1f<>:"/\\|?*]/g,'_').trim().slice(0,120);
  if (!value || value === '.' || value === '..') value='file';
  if (value.startsWith('-')) value='_'+value;
  return value;
}
function extension(name) {
  return path.extname(name).toLowerCase().slice(1);
}
function httpError(status,message) {
  const error=new Error(message);error.status=status;return error;
}
function json(res,status,obj) {
  const body=JSON.stringify(obj);
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(body);
}
async function readJson(req,max=MAX_JSON) {
  const chunks=[];let size=0;
  for await (const chunk of req) {
    size+=chunk.length;if(size>max)throw httpError(413,'Слишком большой запрос');
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch {throw httpError(400,'Некорректный JSON');}
}
async function readRaw(req,dest) {
  const declared=Number(req.headers['content-length'] ?? 0);
  if (!Number.isFinite(declared) || declared>MAX_BYTES) throw httpError(413,'Файл больше 800 МБ');
  let bytes=0;
  const throttle=new Transform({transform(chunk,_enc,callback){
    bytes+=chunk.length;
    if(bytes>MAX_BYTES) callback(httpError(413,'Файл больше 800 МБ'));
    else callback(null,chunk);
  }});
  try {await pipeline(req,throttle,fs.createWriteStream(dest,{flags:'wx'}));}
  catch(error) {await fsp.rm(dest,{force:true}); throw error;}
  if (bytes===0) {await fsp.rm(dest,{force:true});throw httpError(400,'Нельзя загрузить пустой файл');}
  return bytes;
}
async function clearDirectory(dir,age=TTL_MS) {
  const now=Date.now();
  for (const entry of await fsp.readdir(dir,{withFileTypes:true})) {
    if (!entry.isDirectory()) continue;
    const f=path.join(dir,entry.name);
    const stats=await fsp.stat(f).catch(()=>null);
    if(stats && now-stats.mtimeMs>age)await fsp.rm(f,{recursive:true,force:true}).catch(()=>{});
  }
}
async function cleanup() {
  await Promise.all([clearDirectory(JOBS),clearDirectory(UPLOADS)]);
  for(const [id,u] of uploads) if(Date.now()-u.created>TTL_MS)uploads.delete(id);
}
await cleanup();
const timer=setInterval(()=>cleanup().catch(console.error),60*60*1000);
timer.unref();
async function makeJob() {
  const id=crypto.randomUUID().replaceAll('-','');
  const dir=path.join(JOBS,id);
  await fsp.mkdir(dir,{recursive:true});
  return {id,dir};
}
async function jobResult(job,output) {
  const name=path.basename(output);
  const files=await fsp.readdir(job.dir);
  for (const file of files) if(file!==name) await fsp.rm(path.join(job.dir,file),{force:true,recursive:true});
  const stats=await fsp.stat(output);
  return {id:job.id,name,bytes:stats.size,extension:path.extname(name).slice(1).toLowerCase(),download:`/api/download/${job.id}`};
}
async function withJob(callback) {
  const job=await makeJob();
  try {return await callback(job);}
  catch(error) {await fsp.rm(job.dir,{recursive:true,force:true});throw error;}
}
async function serveStatic(res,file,mime) {
  const source=path.join(ROOT,file);
  const stats=await fsp.stat(source);
  res.writeHead(200,{'Content-Type':mime,'Content-Length':stats.size,'X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'});
  fs.createReadStream(source).pipe(res);
}
function allowLocalOrigin(req) {
  const origin=req.headers.origin;
  if(!origin)return;
  try {
    const parsed=new URL(origin);
    if(parsed.protocol==='http:' && ['127.0.0.1','localhost'].includes(parsed.hostname) && Number(parsed.port || 80)===PORT) return;
  } catch {}
  throw httpError(403,'Запросы разрешены только с локального сайта');
}
async function api(req,res,url) {
  allowLocalOrigin(req);
  const pathname=url.pathname;
  if (req.method==='GET' && pathname==='/api/capabilities') return json(res,200,capabilities());
  if (req.method==='GET' && pathname==='/api/health') return json(res,200,{status:'ok',mode:'local',internet_required:false});
  if (req.method==='POST' && pathname==='/api/convert') {
    const name=fileName(url.searchParams.get('filename'));
    const ext=extension(name),target=canonical(url.searchParams.get('target') || '');
    if(!capabilities().inputs[ext]?.includes(target))throw httpError(400,`Конвертация ${ext.toUpperCase()} → ${target.toUpperCase()} недоступна`);
    const q=Number(url.searchParams.get('quality')||85);
    const quality=Number.isFinite(q)?Math.min(100,Math.max(25,Math.round(q))):85;
    const result=await withJob(async job=>{
      const src=path.join(job.dir,name);
      await readRaw(req,src);
      const output=await convert(src,target,job.dir,quality);
      return await jobResult(job,output);
    });
    return json(res,200,result);
  }
  if (req.method==='POST' && pathname==='/api/upload') {
    const name=fileName(url.searchParams.get('filename'));
    const id=crypto.randomUUID().replaceAll('-','');
    const dir=path.join(UPLOADS,id);await fsp.mkdir(dir,{recursive:true});
    const filename=path.join(dir,name);
    try {
      const bytes=await readRaw(req,filename);
      uploads.set(id,{path:filename,name,bytes,created:Date.now()});
      return json(res,200,{id,name,bytes});
    } catch(error) {await fsp.rm(dir,{recursive:true,force:true});throw error;}
  }
  const delUpload=pathname.match(/^\/api\/uploads\/([a-f0-9]{32})$/);
  if (req.method==='DELETE' && delUpload) {
    uploads.delete(delUpload[1]);
    await fsp.rm(path.join(UPLOADS,delUpload[1]),{recursive:true,force:true});
    return json(res,200,{ok:true});
  }
  if (req.method==='POST' && (pathname==='/api/merge-pdf'||pathname==='/api/zip')) {
    const merging=pathname==='/api/merge-pdf';
    const payload=await readJson(req);
    const ids=payload.ids;
    const maximum=merging?30:60;
    if(!Array.isArray(ids) || ids.length<(merging?2:1) || ids.length>maximum || ids.some(id=>!validId(id))) throw httpError(400,`Выбери от ${merging?2:1} до ${maximum} файлов`);
    const files=ids.map(id=>uploads.get(id));
    if(files.some(f=>!f))throw httpError(404,'Один из временных файлов не найден');
    if(files.reduce((s,f)=>s+f.bytes,0)>MAX_BYTES)throw httpError(413,'Общий размер файлов превышает 800 МБ');
    if(merging && files.some(f=>extension(f.name)!=='pdf'))throw httpError(400,'Можно объединять только PDF');
    const result=await withJob(async job=>{
      const output=path.join(job.dir,merging?'merged.pdf':'files.zip');
      if(merging)await mergePDFs(files.map(f=>f.path),output);
      else await zipFiles(files,output);
      return await jobResult(job,output);
    });
    return json(res,200,result);
  }
  const download=pathname.match(/^\/api\/download\/([a-f0-9]{32})$/);
  if (req.method==='GET' && download) {
    const folder=path.join(JOBS,download[1]);
    const names=await fsp.readdir(folder).catch(()=>[]);
    if(names.length!==1)throw httpError(404,'Файл не найден или уже очищен');
    const filename=names[0];const file=path.join(folder,filename);
    const stats=await fsp.stat(file);
    const ascii=filename.replace(/[^A-Za-z0-9._-]/g,'_');
    res.writeHead(200,{
      'Content-Type':'application/octet-stream', 'Content-Length':stats.size,
      'Content-Disposition':`attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
    });
    fs.createReadStream(file).pipe(res);return;
  }
  const deleteJob=pathname.match(/^\/api\/jobs\/([a-f0-9]{32})$/);
  if (req.method==='DELETE' && deleteJob) {
    await fsp.rm(path.join(JOBS,deleteJob[1]),{force:true,recursive:true});
    return json(res,200,{ok:true});
  }
  throw httpError(404,'Маршрут не найден');
}

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url || '/',`http://127.0.0.1:${PORT}`);
  try {
    if(url.pathname.startsWith('/api/')) return await api(req,res,url);
    if(req.method!=='GET')throw httpError(405,'Метод не поддерживается');
    if(url.pathname==='/' || url.pathname==='/index.html') return await serveStatic(res,'index.html','text/html; charset=utf-8');
    if(url.pathname==='/static/styles.css') return await serveStatic(res,'static/styles.css','text/css; charset=utf-8');
    if(url.pathname==='/static/app.js') return await serveStatic(res,'static/app.js','text/javascript; charset=utf-8');
    throw httpError(404,'Страница не найдена');
  } catch(error) {
    const status=error.status || (error.code==='ENOENT'?404:500);
    const message= status>=500 ? 'Ошибка сервера. Проверь терминал.' : error.message;
    if(status>=500)console.error(error);
    if(!res.headersSent) {
      if(url.pathname.startsWith('/api/'))json(res,status,{error:message});
      else {res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8'});res.end(message);}
    } else res.destroy();
  }
});
server.listen(PORT,'127.0.0.1',()=>{
  console.log('\n  NOMAD CONVERT / NPM EDITION');
  console.log(`  Сайт: http://127.0.0.1:${PORT}`);
  console.log('  Остановить: Ctrl+C\n');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';

const PORT = 24580 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
async function api(url,options) {
  const res = await fetch(BASE+url,options);
  const data=await res.json();
  assert.equal(res.ok,true,JSON.stringify(data));
  return data;
}
async function deleteJob(id) {await fetch(`${BASE}/api/jobs/${id}`,{method:'DELETE'});}

test('npm server: API, CSV → JSON, JSON → TSV, ZIP', async () => {
  const proc=spawn(process.execPath,['server/server.js'],{cwd:path.resolve('.'),env:{...process.env,PORT:String(PORT)},stdio:['ignore','pipe','pipe']});
  let failure='';
  proc.stderr.on('data',x=>failure+=x.toString());
  try {
    let started=false;
    for(let n=0;n<60;n++) {
      try {const response=await fetch(BASE+'/api/health');if(response.ok){started=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(started,'Сервер не запустился: '+failure);
    const caps=await api('/api/capabilities');
    assert.ok(caps.inputs.csv.includes('json'));
    assert.equal(caps.offline,true);
    const csv=Buffer.from('name,age\nАлия,24\nБекзат,19\n','utf8');
    const result=await api('/api/convert?filename=sample.csv&target=json',{
      method:'POST',headers:{'Content-Type':'application/octet-stream'},body:csv,
    });
    assert.equal(result.name,'sample.json');
    const data=await (await fetch(BASE+result.download)).json();
    assert.deepEqual(data,[{name:'Алия',age:'24'},{name:'Бекзат',age:'19'}]);
    await deleteJob(result.id);

    const tsv=await api('/api/convert?filename=sample.json&target=tsv',{
      method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.from(JSON.stringify(data)),
    });
    const content=await (await fetch(BASE+tsv.download)).text();
    assert.match(content,/Бекзат\t19/);
    await deleteJob(tsv.id);

    const uploaded=await api('/api/upload?filename=notes.txt',{
      method:'POST',headers:{'Content-Type':'application/octet-stream'},body:Buffer.from('hello zip'),
    });
    const archive=await api('/api/zip',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[uploaded.id]})});
    const bytes=Buffer.from(await (await fetch(BASE+archive.download)).arrayBuffer());
    assert.equal(bytes.readUInt32LE(0),0x04034b50);
    assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);
    await deleteJob(archive.id);
    await fetch(`${BASE}/api/uploads/${uploaded.id}`,{method:'DELETE'});
  } finally {proc.kill('SIGTERM');}
});

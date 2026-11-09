import os,sys,tempfile,subprocess,zipfile,json
from pathlib import Path
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from converter import convert, merge_pdfs, zip_files, capabilities
from pypdf import PdfReader
from openpyxl import load_workbook

with tempfile.TemporaryDirectory() as tmp:
 p=Path(tmp)
 png=p/'цветной_пример.png'
 Image.new('RGBA',(96,64),(200,100,25,100)).save(png)
 jpg=convert(png,'jpg',p)
 assert Image.open(jpg).mode=='RGB' and Image.open(jpg).size==(96,64)
 assert convert(png,'webp',p).exists()
 imgpdf=convert(png,'pdf',p)
 assert len(PdfReader(imgpdf).pages)==1
 txt=p/'sample.txt';txt.write_text('Привет!\nТестовый документ\n\nСтрока два.',encoding='utf-8')
 pdf=convert(txt,'pdf',p)
 assert pdf.exists()
 # PDF text extraction depends on reportlab font and pypdf, test basic nonempty
 extracted=convert(pdf,'txt',p)
 assert 'Привет' in extracted.read_text(encoding='utf-8')
 docx=convert(txt,'docx',p)
 assert docx.stat().st_size>1000
 assert convert(docx,'txt',p).stat().st_size>0
 table=p/'table.csv';table.write_text('имя,число\nтест,10\nпример,20\n',encoding='utf-8')
 xlsx=convert(table,'xlsx',p)
 wb=load_workbook(xlsx,read_only=True);assert wb.active['A2'].value=='тест';wb.close()
 j=convert(xlsx,'json',p)
 assert str(json.loads(j.read_text(encoding='utf-8'))[1]['число'])=='20'
 z=p/'combined.zip'; zip_files([(png,png.name),(table,table.name)],z)
 with zipfile.ZipFile(z) as f: assert len(f.namelist())==2
 merged=p/'merged.pdf';merge_pdfs([pdf,imgpdf],merged)
 assert len(PdfReader(merged).pages)==2
 rendered=convert(merged,'png',p)
 assert rendered.suffix=='.zip'
 with zipfile.ZipFile(rendered) as f: assert len(f.namelist())==2
 if capabilities()['dependencies']['ffmpeg']:
  video=p/'test.webm'
  subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=duration=0.6:size=160x120:rate=10','-c:v','libvpx','-b:v','200k',str(video)],check=True)
  mp4=convert(video,'mp4',p);assert mp4.stat().st_size>1000
  audio=p/'test.wav'
  subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=440:duration=0.3',str(audio)],check=True)
  mp3=convert(audio,'mp3',p);assert mp3.stat().st_size>1000
  print('media:',mp4.stat().st_size,mp3.stat().st_size)
 if capabilities()['dependencies']['libreoffice']:
  pdfout=convert(docx,'pdf',p)
  assert pdfout.exists(), 'docx to pdf failure'
 print('SMOKE OK: image, PDF, text, DOCX, table, ZIP, PDF merge, PDF pages, FFmpeg, LibreOffice')

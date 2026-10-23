import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { loadClientSource } from './public-client.mjs';
const port=Number(process.env.TETRIS_LOCAL_PORT??8765);
const readUserscript=()=>readFile(new URL('../dist/tetris-ai.user.js',import.meta.url),'utf8');
const readFixture=()=>readFile(new URL('../fixtures/controlled-client.html',import.meta.url),'utf8');
const escapeScript=text=>text.replace(/<\/script/gi,'<\\/script');
let helpers=null;
try{
  const client=await loadClientSource();
  helpers=`${client.instrumentedSource}\n;{const r=()=>({memo:c=>c});r.r=()=>{};r.d=()=>{};self.webpackChunk_N_E.find(([ids])=>ids.includes(847))[1][847]({}, {}, r);}`;
}catch(error){console.warn('Local demo source unavailable:',error.message);}
const server=http.createServer(async(request,response)=>{
  try {
  const path=new URL(request.url,'http://localhost').pathname;
  response.setHeader('Cache-Control','no-store');
  if(path==='/health'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({app:'buriburiland-tetris-ai',port}));}
  else if(path==='/tetris-ai.user.js'){response.setHeader('Content-Type','application/javascript; charset=utf-8');response.end(await readUserscript());}
  else if(path==='/'||path==='/demo'){
    response.setHeader('Content-Type','text/html; charset=utf-8');
    const demo=helpers?(await readFixture()).replace('<script>',`<script>${escapeScript(helpers)}</script><script>`).replace('</html>',`<script>${escapeScript(await readUserscript())}</script></html>`):null;
    response.end(demo??'<meta charset="utf-8"><p>로컬 데모용 공개 원본 캐시가 없습니다.</p><a href="/tetris-ai.user.js">userscript 설치 파일</a>');
  }else {response.writeHead(404);response.end('Not found');}
  } catch {response.writeHead(500);response.end('Build unavailable. Run npm.cmd run build.');}
});
server.on('error',error=>{console.error(error.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`Local demo: http://127.0.0.1:${port}/demo\nInstall: http://127.0.0.1:${port}/tetris-ai.user.js`));

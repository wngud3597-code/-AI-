import { chromium } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { loadClientSource, instrumentClientSource } from './public-client.mjs';
const client = await loadClientSource();
const fixture = await readFile('fixtures/controlled-client.html', 'utf8');
const userscript = await readFile('dist/tetris-ai.user.js', 'utf8');
await mkdir('reports', {recursive:true});
const browser = await chromium.launch({channel:'chrome',headless:true});
const page = await browser.newPage({viewport:{width:1200,height:1000},acceptDownloads:true});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const checks={};
const expect=(value,message)=>{if(!value)throw new Error(message);};
const panel = page.locator('#buriburi-ai-host');
const button=name=>panel.getByRole('button',{name,exact:true});
const status=()=>panel.locator('.status').innerText();
try {
  await page.goto('about:blank');
  await page.addScriptTag({content:instrumentClientSource(client.source ?? client)});
  await page.evaluate(() => {
    const requireStub=()=>({memo:component=>component});requireStub.r=()=>{};requireStub.d=()=>{};
    self.webpackChunk_N_E.find(([ids])=>ids.includes(847))[1][847]({}, {}, requireStub);
  });
  // setContent keeps the injected helper while constructing the fixture document.
  await page.setContent(fixture);
  await page.addScriptTag({content:userscript});
  await page.bringToFront();
  expect(await panel.count()===1,'Panel missing');
  const initialStatus=await status();
  expect(initialStatus.startsWith('STOPPED'),'Unexpected initial controller state');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  expect(await status()===initialStatus,'Idle blur overwrote the initial instructions');
  checks.idleBlurPreservesStatus=true;
  await button('상태 점검').click();
  expect((await status()).includes('display-only') && !(await status()).includes('"error"'),'DOM inspection failed: '+await status());
  checks.dom=true;
  await page.keyboard.press('F9');
  const inspectionStatus=await status();
  const inspection=JSON.parse(inspectionStatus);
  const scriptVersion=/@version\s+(\S+)/.exec(userscript)?.[1];
  expect(inspection.scriptVersion===scriptVersion && scriptVersion,'Inspection version differs from the installed userscript');
  expect(inspection.status?.inputEnabled===true && inspection.render?.currentLayers===1 && inspection.render?.fixedCells===200,'Inspection omitted startup readiness diagnostics');
  checks.scriptVersion=scriptVersion;checks.inspectionReadiness=true;
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  expect(await status()===inspectionStatus,'Idle blur overwrote the F9 inspection');
  checks.idleBlurPreservesInspection=true;
  await page.evaluate(()=>{
    self.__fixtureWorker=window.Worker;
    window.Worker=class {constructor(){throw new Error('fixture startup Worker failure');}};
  });
  await button('연속 실행').click();
  await page.waitForFunction(()=>document.querySelector('#buriburi-ai-host')?.shadowRoot?.querySelector('.status')?.textContent.startsWith('ERROR'),{},{timeout:5000});
  const startupError=await status();
  expect(startupError.includes('fixture startup Worker failure'),'Startup error was not displayed: '+startupError);
  expect(await page.evaluate(()=>fixture.events.length===0),'Failed startup sent game input');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  expect(await status()===startupError,'Blur erased the startup error');
  await page.evaluate(()=>{
    const descriptor=Object.getOwnPropertyDescriptor(document,'hidden');
    try {
      Object.defineProperty(document,'hidden',{configurable:true,value:true});
      document.dispatchEvent(new Event('visibilitychange'));
    } finally {
      if(descriptor)Object.defineProperty(document,'hidden',descriptor);
      else delete document.hidden;
    }
  });
  expect(await status()===startupError,'Hidden-tab notification erased the startup error');
  await page.locator('#chat').focus();
  expect(await status()===startupError,'Editable focus erased the startup error');
  checks.environmentPreservesStartupError=true;
  await page.locator('#chat').blur();
  await page.evaluate(()=>{window.Worker=self.__fixtureWorker;delete self.__fixtureWorker;});
  await page.evaluate(()=>{
    document.querySelector('.tetris-visible-board > .tetris-piece-layer:not(.is-ghost)').remove();
    document.querySelector('#buriburi-ai-host').shadowRoot.querySelector('[data-action="continuous"]').click();
  });
  await page.keyboard.press('F8');
  await page.evaluate(()=>fixture.render());
  await page.waitForTimeout(200);
  expect(await page.evaluate(()=>fixture.events.length===0),'Cancelled spawn observation sent input after the piece returned');
  expect((await status()).startsWith('STOPPED'),'Cancelled spawn observation restarted');
  checks.f8CancelsSpawnObservation=true;
  const transientStatus=await page.evaluate(()=>{
    document.querySelector('.tetris-visible-board > .tetris-piece-layer:not(.is-ghost)').remove();
    const root=document.querySelector('#buriburi-ai-host').shadowRoot;
    root.querySelector('[data-action="shadow"]').click();
    setTimeout(()=>fixture.render(),100);
    return root.querySelector('.status').textContent;
  });
  expect(!transientStatus.startsWith('ERROR'),'Transient spawn absence immediately failed: '+transientStatus);
  await page.waitForFunction(()=>document.querySelector('#buriburi-ai-host')?.shadowRoot?.querySelector('.status')?.textContent.includes('게임 입력 0회'),{},{timeout:5000});
  expect(await page.evaluate(()=>fixture.events.length===0),'Shadow sent input');checks.shadowZeroInputs=true;
  checks.spawnTransitionRecovers=true;
  await button('연속 실행').click();
  await page.waitForFunction(()=>fixture.state.locks>=20 || /ERROR/.test(document.querySelector('#buriburi-ai-host').shadowRoot.querySelector('.status').textContent),{},{timeout:45000});
  expect(await page.evaluate(()=>fixture.state.locks>=20),'Continuous control failed: '+await status());
  await page.keyboard.press('F8');
  const stoppedCount=await page.evaluate(()=>fixture.events.filter(e=>e.type==='keydown').length);
  await page.waitForTimeout(350);
  expect(await page.evaluate(()=>fixture.events.filter(e=>e.type==='keydown').length)===stoppedCount,'Input continued after F8');
  checks.continuousLocks=await page.evaluate(()=>fixture.state.locks);checks.f8NoFurtherKeydowns=true;
  const gravityConfirmedBefore=Number(/표시 검증 (\d+)회/.exec(await status())?.[1]);
  expect(Number.isFinite(gravityConfirmedBefore),'Cannot read the gravity regression baseline');
  await page.evaluate(()=>{
    const NativeWorker=window.Worker;
    self.__fixtureWorker=NativeWorker;
    fixture.gravityRequests=0;fixture.gravityDrops=0;
    window.Worker=class extends NativeWorker {
      postMessage(message,...options) {
        fixture.gravityRequests++;
        const before=fixture.state.current;
        const after=__client.apply('soft_drop',fixture.state.board,before);
        if(after && after.y>before.y)fixture.gravityDrops++;
        fixture.state.current=after;
        fixture.render();
        super.postMessage(message,...options);
      }
    };
  });
  await button('연속 실행').click();
  await page.waitForFunction(target=>{
    const text=document.querySelector('#buriburi-ai-host').shadowRoot.querySelector('.status').textContent;
    return Number(/표시 검증 (\d+)회/.exec(text)?.[1])>=target || text.startsWith('ERROR');
  },gravityConfirmedBefore+3,{timeout:15000});
  const gravityConfirmedAfter=Number(/표시 검증 (\d+)회/.exec(await status())?.[1]);
  expect(gravityConfirmedAfter>=gravityConfirmedBefore+3,'Descent during every search prevented verified placements: '+await status());
  await page.keyboard.press('F8');
  const gravity=await page.evaluate(()=>{
    window.Worker=self.__fixtureWorker;delete self.__fixtureWorker;
    return {requests:fixture.gravityRequests,drops:fixture.gravityDrops};
  });
  expect(gravity.requests>=3 && gravity.drops===gravity.requests,'Gravity was not applied during every planner request: '+JSON.stringify(gravity));
  checks.gravitySearchRequests=gravity.requests;
  checks.gravitySearchDrops=gravity.drops;
  checks.gravityVerifiedPlacements=gravityConfirmedAfter-gravityConfirmedBefore;
  await page.waitForTimeout(100);
  await button('연속 실행').click();
  await page.waitForFunction(()=>/^(OBSERVING|PLANNING|EXECUTING|AWAITING_RESULT|VALIDATING|RESYNC)\b/.test(document.querySelector('#buriburi-ai-host').shadowRoot.querySelector('.status').textContent),{},{timeout:5000});
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  const blurCount=await page.evaluate(()=>fixture.events.filter(e=>e.type==='keydown').length);
  expect((await status()).startsWith('STOPPED') && (await status()).includes('포커스'),'Active blur did not stop control');
  await page.waitForTimeout(350);
  expect(await page.evaluate(()=>fixture.events.filter(e=>e.type==='keydown').length)===blurCount,'Input continued or restarted after blur');
  checks.activeBlurStopsWithoutRestart=true;
  await button('연속 실행').click();await page.waitForTimeout(20);
  await page.locator('#chat').focus();
  const chatCount=await page.evaluate(()=>fixture.events.filter(e=>e.type==='keydown').length);
  await page.waitForTimeout(250);
  expect(await page.evaluate(()=>fixture.events.filter(e=>e.type==='keydown').length)===chatCount,'Input continued in chat');checks.chatStop=true;
  await page.locator('#chat').blur();
  await page.evaluate(()=>fixture.setPaused(true));
  await button('한 수 실행').click();await page.waitForTimeout(150);
  expect(await page.evaluate(()=>fixture.events.filter(e=>e.type==='keydown').length)===chatCount,'Input sent while paused');checks.pauseBlocks=true;
  await page.evaluate(()=>fixture.setPaused(false));
  const downloadPromise=page.waitForEvent('download');await button('검증 기록 저장').click();
  const download=await downloadPromise;await download.saveAs('reports/browser-evidence.jsonl');
  const records=(await readFile('reports/browser-evidence.jsonl','utf8')).trim().split('\n').map(JSON.parse);
  records.forEach(record=>{record.evidence='local-browser-fixture';});
  await writeFile('reports/browser-evidence.jsonl',records.map(record=>JSON.stringify(record)).join('\n')+'\n');
  checks.recordedLocks=records.filter(r=>r.result==='display-match').length;
  expect(records.every(r=>r.validation.authoritative==='unknown'),'Authority falsely claimed');
  expect(!JSON.stringify(records).includes('about:blank'),'URL leaked');
  const sent=await page.evaluate(()=>fixture.events.filter(e=>e.type==='keydown').length);
  checks.sentGameKeydowns=sent;checks.exportRecords=records.length;
  const down=records.flatMap(r=>r.actions).length;
  checks.recordedGameKeydowns=down;
  expect(down===sent,'Sent inputs differ from recorded actions');
  await page.screenshot({path:'reports/browser-check.png',fullPage:true});
  expect(errors.length===0,'Browser errors: '+errors.join(';'));
  const result={environment:'local Chrome fixture using public client helpers; no site/server/Tampermonkey claim',checks,errors};
  await writeFile('reports/browser-check.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
} catch(error) {
  await page.screenshot({path:'reports/browser-failure.png',fullPage:true});
  console.error(JSON.stringify({checks,errors,status:await status().catch(()=>''),error:String(error)},null,2));process.exitCode=1;
} finally {await browser.close();}

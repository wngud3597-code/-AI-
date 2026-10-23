import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import { SCRIPT_VERSION } from '../src/runtime/version.ts';
const json=async path=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const browser=await json('reports/browser-check.json');
const contract=await json('reports/source-contract.json');
const manifest=await json('dist/manifest.json');
const benchmark=await json('logs/benchmark-latest.json');
const unit=await json('reports/unit-tests.json');
const garbage=await json('reports/garbage-browser-check.json');
const garbageReplay=await json('reports/garbage-replay-summary.json');
const userLogs=await json('reports/user-log-audit.json');
const replay=await json('reports/replay-summary.json');
const installer=await json('reports/installer-check.json');
const gauges=await json('reports/gauge-browser-check.json');
if(!unit.success || unit.numFailedTests || !garbage.passed || !garbageReplay.passed || !replay.passed
  || browser.errors.length || browser.checks.scriptVersion!==SCRIPT_VERSION
  || !gauges.passed || gauges.scriptVersion!==SCRIPT_VERSION || gauges.userscriptSha256!==manifest['tetris-ai.user.js'].sha256
  || installer.version!==SCRIPT_VERSION || installer.sha256!==manifest['tetris-ai.user.js'].sha256)throw new Error('Verification evidence contains failures or a different build');
const unitSummary={status:'passed',tests:unit.numTotalTests,passed:unit.numPassedTests,files:unit.testResults.length,source:'reports/unit-tests.json'};
const sourceComparisons=Object.values(contract.comparisons).reduce((sum,value)=>sum+value.compared,0);
const records=(await readFile('reports/browser-evidence.jsonl','utf8')).trim().split('\n').map(JSON.parse);
const counts={};
for(const record of records)counts[record.result]=(counts[record.result]??0)+1;
const digest=createHash('sha256');
async function files(root){
  const result=[];
  for(const entry of await readdir(root,{withFileTypes:true})){
    const path=`${root}/${entry.name}`;
    if(entry.isDirectory())result.push(...await files(path));else result.push(path);
  }
  return result;
}
const sources=[...(await files('src')),...(await files('scripts')),...(await files('fixtures')),'package-lock.json'].sort();
for(const path of sources){digest.update(path);digest.update(await readFile(path));}
const result={
  version:SCRIPT_VERSION,verifiedAt:new Date().toISOString(), timezone:'Asia/Seoul',
  provenance:{upstreamCommit:'e7fdbc1420972a7f8b43b4704820f989dec742d5',acquisition:'GitHub connector text snapshot; git clone failed',downloadedTextFiles:61,skippedImages:2,localGitHead:null,baselineV4GitBlob:'95a7398743ee3406efefd29950f67642fb9bf548'},
  codeSha256:digest.digest('hex'),artifacts:manifest,
  environment:{platform:os.platform(),osRelease:os.release(),arch:os.arch(),cpu:os.cpus()[0].model,logicalCPUs:os.cpus().length,memoryGiB:Math.round(os.totalmem()/2**30),node:process.version},
  commands:{'npm.cmd ci --ignore-scripts':'passed in initial setup; not repeated after @types/node addition','npm.cmd install --save-dev --save-exact @types/node --ignore-scripts':'passed; installation audit reported zero vulnerabilities','npm.cmd run build':'passed','npm.cmd test':unitSummary,'npm.cmd run typecheck':'passed','npm.cmd run verify:source':`${contract.status}; original comparison retained, physics unchanged`,'npm.cmd run test:browser':'passed','npm.cmd run test:garbage':'passed','npm.cmd run benchmark':'initial smoke retained; strategy unchanged','npm.cmd run replay -- reports/garbage-*.jsonl':'passed individually; see garbage-replay-summary.json','npm.cmd run replay -- reports/browser-evidence.jsonl':'passed; includes paths revalidated after gravity','local installer':installer},
  clientSource:{sha256:contract.source.sha256,comparisons:contract.comparisons,excluded:contract.excluded},
  browser:{...browser,recordResults:counts,evidence:'local-browser-fixture'},
  gaugeOwnership: gauges,
  startupRecovery:{transientObservation:'typed transition retry bounded to 1200 ms; cancellation and game-state guards retained',gravity:'full original and fresh path revalidation across all observed rotations; identical terminal placement required',diagnostics:'startup errors survive environmental stop events; version and game status included',replay},
  garbageRecovery:{browser:garbage,replay:garbageReplay,userEvidence:{...userLogs.total,files:userLogs.files,regressionFixture:userLogs.regressionFixture,scope:userLogs.scope,audit:'reports/user-log-audit.json'}},
  benchmark:{settings:benchmark.settings,totalLocks:benchmark.runs.reduce((sum,run)=>sum+run.locks,0),evidence:benchmark.evidence},
  stages:{offline:'passed',publicClientOffline:'passed with unchanged physics',localChrome:'passed including garbage recovery',actualSiteShadow:'not independently run',actualSiteSingleStep:'not independently run',actualSiteLive:`user-provided ${userLogs.total.records} display records analyzed; patched build live execution not verified`,tampermonkeyCSP:'user-provided records lack script version; patched install not verified',real1000LockGate:'not achieved',competitiveAndHuman:'not independently evaluated'},
  limitations:['Public DOM may contain client prediction; no authoritative server claim','180/spin/attack/cancel/insertion timing disabled or unknown','Unexpected board changes during execution may safely stop','Local fixture has no automatic gravity, server, or opponents','Replay validates action order but does not evolve gravity/lock timing','Synthetic garbage benchmark is not a site distribution; deeper search regressed on its garbage sample']
};
await writeFile('reports/verification.json',JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({version:result.version,tests:unitSummary.tests,sourceComparisons,browser:browser.checks,garbageChecks:garbage.checks.length,garbageReplay:garbageReplay.passed,recordResults:counts,codeSha256:result.codeSha256},null,2));

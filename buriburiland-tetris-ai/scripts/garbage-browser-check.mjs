import { chromium } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { loadClientSource, instrumentClientSource } from './public-client.mjs';

const client = await loadClientSource();
const fixtureSource = await readFile('fixtures/controlled-client.html', 'utf8');
const userscript = await readFile('dist/tetris-ai.user.js', 'utf8');
const reportPath = 'reports/garbage-browser-check.json';
const scenarios = [
  { name: 'movement-one-row', trigger: 'movement', holes: [6], phase: 'movement' },
  { name: 'after-lock-one-row', trigger: 'hard_drop', holes: [6], phase: 'after-lock' },
  { name: 'after-lock-four-rows', trigger: 'hard_drop', holes: [8, 8, 8, 8], phase: 'after-lock' },
  { name: 'after-hold-one-row', trigger: 'hold', holes: [6], phase: 'after-hold', setup: 'hold-well' },
  { name: 'f8-during-recovery', trigger: 'movement', holes: [6], phase: 'movement', stopDuringRecovery: true },
];
const expect = (value, message) => { if (!value) throw new Error(message); };
await mkdir('reports', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];

async function createPage(scenario) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, acceptDownloads: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('about:blank');
  await page.addScriptTag({ content: instrumentClientSource(client.source) });
  await page.evaluate(() => {
    const requireStub = () => ({ memo: component => component });
    requireStub.r = () => {};
    requireStub.d = () => {};
    self.webpackChunk_N_E.find(([ids]) => ids.includes(847))[1][847]({}, {}, requireStub);
  });
  await page.setContent(fixtureSource);
  // Install after the fixture's input listener: injection observes an already
  // acknowledged movement, HOLD, or actual lock, rather than inventing a lock.
  await page.evaluate(options => {
    const { state, events } = window.fixture;
    const C = window.__client;
    if (options.setup === 'hold-well') {
      state.board = Array.from({ length: 20 }, (_, y) =>
        Array.from({ length: 10 }, (_, x) => y >= 16 && x !== 8 ? 8 : 0));
      state.current = C.spawn('O', state.board);
      state.hold = 'I';
      state.canHold = true;
      window.fixture.render();
    }
    const boardBits = () => state.board.map(row => row.reduce((bits, value, x) => bits | (value ? 1 << x : 0), 0));
    const keydowns = () => events.filter(event => event.type === 'keydown').length;
    window.garbageCheck = { injection: null, statusHistory: [], stopped: null, f8Keydowns: null, hardDrops: [] };
    window.addEventListener('keydown', event => {
      if (event.code === 'F8') {
        window.garbageCheck.f8Keydowns ??= keydowns();
        return;
      }
      const action = C.key(event.key, event.code);
      if (action === 'hard_drop') window.garbageCheck.hardDrops.push({ locks: state.locks, keydowns: keydowns() });
      if (window.garbageCheck.injection) return;
      const matches = options.trigger === 'movement'
        ? action === 'move_left' || action === 'move_right'
        : action === options.trigger;
      if (!matches) return;
      const before = boardBits();
      window.fixture.insertGarbage(options.holes);
      window.garbageCheck.injection = {
        trigger: action, holes: [...options.holes], rows: options.holes.length,
        at: performance.now(), firstLockCount: state.locks,
        keydowns: keydowns(), before, after: boardBits(),
      };
    });
    if (options.stopDuringRecovery) {
      window.garbageCheck.observeRecoveryStop = () => {
        const status = document.querySelector('#buriburi-ai-host').shadowRoot.querySelector('.status');
        const stop = () => {
          const text = status.textContent;
          window.garbageCheck.statusHistory.push(text);
          if (!window.garbageCheck.injection || window.garbageCheck.stopped || !text.startsWith('RESYNC')) return;
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', code: 'F8', bubbles: true }));
          window.dispatchEvent(new KeyboardEvent('keyup', { key: 'F8', code: 'F8', bubbles: true }));
          window.garbageCheck.stopped = { keydowns: keydowns(), locks: state.locks };
        };
        new MutationObserver(stop).observe(status, { childList: true, subtree: true, characterData: true });
      };
    }
  }, scenario);
  await page.addScriptTag({ content: userscript });
  await page.bringToFront();
  await page.evaluate(() => window.garbageCheck.observeRecoveryStop?.());
  return { page, errors };
}

async function exportRecords(page, name) {
  const pendingDownload = page.waitForEvent('download', { timeout: 5000 });
  await page.locator('#buriburi-ai-host').getByRole('button', { name: '검증 기록 저장', exact: true }).click();
  const download = await pendingDownload;
  const path = `reports/garbage-${name}.jsonl`;
  await download.saveAs(path);
  const lines = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean);
  return { path, records: lines.map(JSON.parse) };
}

async function checkScenario(scenario) {
  const result = { name: scenario.name, passed: false, injection: null, errors: [] };
  let page;
  try {
    ({ page, errors: result.errors } = await createPage(scenario));
    await page.locator('#buriburi-ai-host').getByRole('button', { name: '연속 실행', exact: true }).click();
    await page.waitForFunction(({ stopDuringRecovery }) => {
      const check = window.garbageCheck;
      const status = document.querySelector('#buriburi-ai-host').shadowRoot.querySelector('.status').textContent;
      if (status.startsWith('ERROR')) return true;
      return stopDuringRecovery ? Boolean(check.stopped)
        : check.injection && window.fixture.state.locks >= check.injection.firstLockCount + 3
          && status.startsWith('VALIDATING');
    }, scenario, { timeout: 25000 });
    result.statusBeforeStop = await page.locator('#buriburi-ai-host .status').innerText();
    result.injection = await page.evaluate(() => window.garbageCheck.injection);
    expect(result.injection, `No ${scenario.trigger} event reached the injection hook`);
    expect(!result.statusBeforeStop.startsWith('ERROR'), `Controller stopped: ${result.statusBeforeStop}`);
    if (scenario.stopDuringRecovery) {
      expect(await page.evaluate(() => Boolean(window.garbageCheck.stopped)), 'F8 was not dispatched during RESYNC');
    } else {
      expect(await page.evaluate(() => window.fixture.state.locks >= window.garbageCheck.injection.firstLockCount + 3),
        'Continuous play did not complete three new locks after garbage');
      await page.keyboard.press('F8');
    }
    await page.waitForTimeout(350);
    const afterStop = await page.evaluate(() => ({
      keydowns: window.fixture.events.filter(event => event.type === 'keydown').length,
      locks: window.fixture.state.locks,
      hardDrops: window.fixture.events.filter(event => event.type === 'keydown' && event.action === 'hard_drop').length,
      hardDropChecks: window.garbageCheck.hardDrops,
      recoveryStop: window.garbageCheck.stopped,
      f8Keydowns: window.garbageCheck.f8Keydowns,
    }));
    result.firstLockCount = result.injection.firstLockCount;
    result.finalLocks = afterStop.locks;
    result.newLocksAfterInjection = afterStop.locks - result.injection.firstLockCount;
    result.sentGameKeydowns = afterStop.keydowns;
    result.newGameKeydownsAfterInjection = afterStop.keydowns - result.injection.keydowns;
    expect(afterStop.f8Keydowns !== null, 'F8 keydown was not observed by the fixture hook');
    result.keydownsAfterF8 = afterStop.keydowns - afterStop.f8Keydowns;
    result.duplicateHardDrops = afterStop.hardDrops - afterStop.locks;
    expect(result.keydownsAfterF8 === 0, 'Game keydown was sent after F8');
    expect(result.duplicateHardDrops === 0, 'Hard-drop keydown count differs from actual lock count');
    expect(afterStop.hardDropChecks.every((drop, index) => drop.locks === index + 1), 'Hard drop did not create exactly one new lock');
    const { path, records } = await exportRecords(page, scenario.name);
    result.evidencePath = path;
    result.exportRecords = records.length;
    result.recordedGameKeydowns = records.flatMap(record => record.actions).length;
    const resyncs = records.filter(record => record.result === 'resynced');
    result.observedResyncs = resyncs.map(record => ({
      reason: record.recovery?.reason, phase: record.recovery?.phase,
      rows: record.recovery?.rise?.rows, holes: record.recovery?.rise?.holes,
      completedAction: record.recovery?.completedAction,
      reference: record.recovery?.reference,
      hardDrops: record.actions.filter(action => action.action === 'HARD_DROP').length,
    }));
    expect(result.recordedGameKeydowns === result.sentGameKeydowns, 'Sent game keydowns differ from evidence actions');
    expect(records.every(record => record.validation.authoritative === 'unknown'), 'Local fixture falsely claims server authority');
    const resync = resyncs.find(record => record.recovery?.reason === 'garbage-rise'
      && record.recovery?.phase === scenario.phase && record.recovery?.rise?.rows === scenario.holes.length
      && JSON.stringify(record.recovery.rise.holes) === JSON.stringify(scenario.holes));
    expect(resync, `Missing ${scenario.phase} garbage-rise recovery evidence`);
    expect(resync.validation.board === 'unknown' && resync.validation.insertion === 'unknown' && resync.validation.attack === 'unknown',
      'Garbage recovery falsely claims a predicted board or server insertion/attack match');
    const hardDrops = resync.actions.filter(action => action.action === 'HARD_DROP').length;
    expect(hardDrops === (scenario.phase === 'after-lock' ? 1 : 0), 'Stale placement sent an extra hard drop');
    expect(resync.recovery.completedAction === (scenario.phase === 'after-lock' ? 'HARD_DROP' : scenario.phase === 'after-hold' ? 'HOLD' : null),
      'Recovery completed-action evidence is incorrect');
    expect(resync.recovery.reference === (scenario.phase === 'after-lock' ? 'predicted-lock' : 'before'),
      'Recovery compared the wrong reference board');
    if (!scenario.stopDuringRecovery) {
      const later = records.slice(records.indexOf(resync) + 1).filter(record => record.result === 'display-match');
      result.verifiedLocksAfterResync = later.length;
      expect(later.length >= 3, 'New board was not replanned into three verified placements');
    }
    expect(result.errors.length === 0, `Browser errors: ${result.errors.join('; ')}`);
    result.passed = true;
  } catch (error) {
    result.error = String(error);
    if (page) {
      result.status = await page.locator('#buriburi-ai-host .status').innerText().catch(() => '');
      result.injection = await page.evaluate(() => window.garbageCheck?.injection ?? null).catch(() => null);
      await page.screenshot({ path: `reports/garbage-${scenario.name}-failure.png`, fullPage: true }).catch(() => {});
      await page.keyboard.press('F8').catch(() => {});
      // Keep failure evidence reviewable too; some failures happen before a
      // placement can be recorded, so an empty export is allowed here only.
      if (await page.locator('#buriburi-ai-host').count()) {
        await exportRecords(page, scenario.name).then(({ path, records }) => {
          result.evidencePath = path;
          result.failureRecords = records.map(record => ({ result: record.result, error: record.error, recovery: record.recovery }));
        }).catch(() => {});
      }
    }
  } finally {
    await page?.close();
  }
  return result;
}

try {
  for (const scenario of scenarios) {
    const result = await checkScenario(scenario);
    results.push(result);
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${scenario.name}${result.error ? `: ${result.error}` : ''}`);
  }
} finally {
  await browser.close();
  const report = {
    environment: 'Offline local Chrome fixture with SHA256-verified public client helpers; no live-site, server, or Tampermonkey claim',
    clientSha256: client.sha256,
    passed: results.length === scenarios.length && results.every(result => result.passed),
    checks: results,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}

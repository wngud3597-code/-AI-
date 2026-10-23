import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { loadClientSource, instrumentClientSource } from './public-client.mjs';

const client = await loadClientSource();
const fixtureSource = await readFile('fixtures/controlled-client.html', 'utf8');
const userscript = await readFile('dist/tetris-ai.user.js', 'utf8');
const scriptVersion = /@version\s+(\S+)/.exec(userscript)?.[1];
const userscriptSha256 = createHash('sha256').update(userscript).digest('hex');
const reportPath = 'reports/gauge-browser-check.json';
const scenarios = [
  { name: 'one-opponent-visible', opponentCount: 1, slotVisible: true, ownIncoming: 17 },
  { name: 'one-opponent-hidden', opponentCount: 1, slotVisible: false, ownIncoming: 17 },
  { name: 'two-opponents-visible', opponentCount: 2, slotVisible: true, ownIncoming: 17 },
  { name: 'two-opponents-hidden', opponentCount: 2, slotVisible: false, ownIncoming: 17 },
  { name: 'own-absent-two-opponents', opponentCount: 2, slotVisible: true, ownIncoming: null },
];
const expect = (value, message) => { if (!value) throw new Error(message); };
expect(scriptVersion, 'Built userscript has no version metadata');
await mkdir('reports', { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results = [];

function gaugeMarkup(incoming, compact = false) {
  return `<div class="tetris-garbage-gauge${compact ? ' is-compact' : ''}"><div class="tetris-garbage-gauge-track" role="meter" aria-label="받은 공격 ${incoming}줄" aria-valuemin="0" aria-valuemax="8" aria-valuenow="${Math.min(8, incoming)}"></div></div>`;
}

function fixtureFor(scenario) {
  const own = scenario.ownIncoming === null ? '' : gaugeMarkup(scenario.ownIncoming);
  const opponents = [2, 31].slice(0, scenario.opponentCount).map(incoming =>
    `<div class="tetris-opponent"><div class="tetris-opponent-details">${gaugeMarkup(incoming, true)}</div></div>`).join('');
  const slot = `<div class="tetris-mobile-opponent-slot" style="display:${scenario.slotVisible ? 'block' : 'none'};min-height:12px">${opponents}</div>`;
  const anchor = '<div class="tetris-metrics">';
  expect(fixtureSource.split(anchor).length === 2, 'Fixture metrics anchor is missing or ambiguous');
  // This is inserted into the fixture render template so it survives every
  // movement, HOLD, and lock render. The opponent hierarchy is source-observed.
  return fixtureSource.replace(anchor, anchor + own + slot);
}

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
  await page.setContent(fixtureFor(scenario));
  await page.evaluate(() => {
    window.gaugeCheck = { keydownsAtF8: null };
    window.addEventListener('keydown', event => {
      if (event.code === 'F8') {
        window.gaugeCheck.keydownsAtF8 ??= window.fixture.events.filter(e => e.type === 'keydown').length;
      }
    });
  });
  await page.addScriptTag({ content: userscript });
  await page.bringToFront();
  return { page, errors };
}

async function exportRecords(page, name) {
  const pending = page.waitForEvent('download', { timeout: 5000 });
  await page.locator('#buriburi-ai-host').getByRole('button', { name: '검증 기록 저장', exact: true }).click();
  const download = await pending;
  const path = `reports/gauge-${name}.jsonl`;
  await download.saveAs(path);
  const records = (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  records.forEach(record => { record.evidence = 'local-browser-fixture'; });
  await writeFile(path, records.map(record => JSON.stringify(record)).join('\n') + '\n');
  return { path, records };
}

async function checkScenario(scenario) {
  const result = { ...scenario, passed: false, errors: [] };
  let page;
  try {
    ({ page, errors: result.errors } = await createPage(scenario));
    const panel = page.locator('#buriburi-ai-host');
    const status = () => panel.locator('.status').innerText();
    expect(await panel.count() === 1, 'AI panel is missing');
    expect((await panel.locator('h2').innerText()).includes(`v${scriptVersion}`), 'Panel version differs from built script');
    expect(await page.locator('.tetris-mobile-opponent-slot').isVisible() === scenario.slotVisible,
      'Opponent slot visibility differs from the test case');
    expect(await page.locator('.tetris-mobile-opponent-slot [role="meter"]').count() === scenario.opponentCount,
      'The nested opponent gauges were not constructed');
    result.totalIncomingGauges = await page.locator('.tetris-left-panel .tetris-garbage-gauge-track[role="meter"]').count();
    expect(result.totalIncomingGauges === scenario.opponentCount + (scenario.ownIncoming === null ? 0 : 1),
      'Total descendant gauge count does not exercise the original duplicate-selector condition');
    await page.keyboard.press('F9');
    result.inspection = JSON.parse(await status());
    expect(!result.inspection.error, `F9 inspection failed: ${result.inspection.error}`);
    expect(result.inspection.scriptVersion === scriptVersion, 'F9 version differs from built userscript');
    expect(result.inspection.snapshot?.incoming === scenario.ownIncoming,
      `F9 incoming must be ${scenario.ownIncoming}; got ${result.inspection.snapshot?.incoming}`);
    expect(result.inspection.render?.ownIncomingGauges === (scenario.ownIncoming === null ? 0 : 1),
      'F9 own-gauge diagnostics included an opponent gauge');
    expect(result.inspection.authority === 'display-only', 'F9 falsely claims server authority');
    await panel.getByRole('button', { name: '연속 실행', exact: true }).click();
    await page.waitForFunction(() => {
      const text = document.querySelector('#buriburi-ai-host').shadowRoot.querySelector('.status').textContent;
      return text.startsWith('ERROR') || (window.fixture.state.locks >= 3 && text.startsWith('VALIDATING'));
    }, {}, { timeout: 20000 });
    result.statusBeforeStop = await status();
    expect(!result.statusBeforeStop.startsWith('ERROR'), `Continuous play stopped: ${result.statusBeforeStop}`);
    await page.keyboard.press('F8');
    await page.waitForTimeout(350);
    result.finalStatus = await status();
    const events = await page.evaluate(() => ({
      locks: window.fixture.state.locks,
      sent: window.fixture.events.filter(event => event.type === 'keydown').length,
      hardDrops: window.fixture.events.filter(event => event.type === 'keydown' && event.action === 'hard_drop').length,
      atF8: window.gaugeCheck.keydownsAtF8,
      opponentGauges: document.querySelectorAll('.tetris-mobile-opponent-slot [role="meter"]').length,
    }));
    expect(result.finalStatus.startsWith('STOPPED'), 'F8 did not stop the controller');
    expect(events.atF8 !== null, 'F8 was not observed');
    result.keydownsAfterF8 = events.sent - events.atF8;
    expect(result.keydownsAfterF8 === 0, 'Game input continued after F8');
    expect(events.opponentGauges === scenario.opponentCount, 'Opponents disappeared during fixture renders');
    result.actualLocks = events.locks;
    result.sentGameKeydowns = events.sent;
    result.duplicateHardDrops = events.hardDrops - events.locks;
    expect(result.duplicateHardDrops === 0, 'Hard-drop input count differs from actual locks');
    const { path, records } = await exportRecords(page, scenario.name);
    result.evidencePath = path;
    result.exportRecords = records.length;
    result.recordedGameKeydowns = records.flatMap(record => record.actions).length;
    result.displayMatchedPlacements = records.filter(record => record.result === 'display-match').length;
    result.observedIncoming = [...new Set(records.flatMap(record => [record.before.incoming, ...(record.after ? [record.after.incoming] : [])]))];
    expect(result.displayMatchedPlacements >= 3, 'Fewer than three placements matched the displayed board');
    expect(result.recordedGameKeydowns === result.sentGameKeydowns, 'Recorded inputs differ from emitted game keydowns');
    expect(records.every(record => record.before.incoming === scenario.ownIncoming
      && (!record.after || record.after.incoming === scenario.ownIncoming)), 'Opponent/capped incoming value contaminated the evidence');
    expect(records.every(record => record.scriptVersion === scriptVersion), 'Evidence version differs from the installed script');
    expect(records.every(record => record.validation.authoritative === 'unknown'), 'Fixture evidence falsely claims server authority');
    expect(records.every(record => record.evidence === 'local-browser-fixture'), 'Fixture evidence lacks its local tag');
    expect(result.errors.length === 0, `Browser errors: ${result.errors.join('; ')}`);
    result.passed = true;
  } catch (error) {
    result.error = String(error);
    if (page) {
      result.failureStatus = await page.locator('#buriburi-ai-host .status').innerText().catch(() => '');
      await page.screenshot({ path: `reports/gauge-${scenario.name}-failure.png`, fullPage: true }).catch(() => {});
      await page.keyboard.press('F8').catch(() => {});
      if (await page.locator('#buriburi-ai-host').count()) {
        await exportRecords(page, scenario.name).then(({ path, records }) => {
          result.evidencePath = path;
          result.failureRecords = records.map(record => ({ result: record.result, error: record.error }));
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
    environment: 'Offline Chrome fixture using verified public client helpers and nested opponent gauge markup; no live-site, server, or Tampermonkey claim',
    clientSha256: client.sha256,
    scriptVersion,
    userscriptSha256,
    passed: results.length === scenarios.length && results.every(result => result.passed),
    checks: results,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ reportPath, scriptVersion, passed: report.passed, checks: results.length }, null, 2));
  if (!report.passed) process.exitCode = 1;
}

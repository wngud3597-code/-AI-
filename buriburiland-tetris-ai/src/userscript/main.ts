import { DomAdapter } from '../runtime/dom';
import { Controller, WindowKeyboard, isEditable } from '../runtime/control';
import { WorkerPlanner } from '../runtime/worker-client';
import { SCRIPT_VERSION } from '../runtime/version';

if (!document.getElementById('buriburi-ai-host')) {
  const host = document.createElement('div'); host.id = 'buriburi-ai-host';
  host.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:2147483646;max-width:calc(100vw - 28px)';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{color-scheme:dark}*{box-sizing:border-box}.panel{width:318px;padding:16px;border:1px solid #37758c;border-radius:12px;background:#0b1626f5;color:#e6f0ff;font:13px/1.55 system-ui,sans-serif;box-shadow:0 8px 32px #0007}h2{margin:0;font-size:16px}.tag{font-size:11px;color:#94b6d1;margin:3px 0 12px}.buttons{display:grid;grid-template-columns:1fr 1fr;gap:7px}button{cursor:pointer;border:1px solid #45637f;border-radius:6px;padding:8px;background:#19314a;color:#f1f7ff;font:inherit}button:hover{background:#294b6c}.stop{background:#6b2734}.start{background:#175b50}.status{margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:190px;overflow:auto}small{display:block;color:#a4bed4;margin-top:8px}.min{float:right;padding:0 8px}.hidden{display:none}
    </style><section class="panel" aria-label="테트리스 AI"><button class="min" aria-label="패널 접기">−</button><h2>테트리스 AI v${SCRIPT_VERSION}</h2><div class="body"><p class="tag">직접 시작 · F8 즉시 중지 · F9 상태 점검</p><div class="buttons"><button data-action="inspect">상태 점검</button><button data-action="select">내 보드 선택</button><button data-action="shadow">관측·탐색만</button><button data-action="single">한 수 실행</button><button data-action="continuous" class="start">연속 실행</button><button data-action="stop" class="stop">중지 F8</button><button data-action="export">검증 기록 저장</button></div><div class="status" role="status">STOPPED\n게임을 시작한 뒤 F9로 자기 보드를 확인하세요.</div><small>DOM 표시 결과를 검증합니다. 서버 확정·공격 규칙·대전 실력은 미검증입니다.</small></div></section>`;
  document.body.append(host);
  const status = root.querySelector<HTMLElement>('.status')!;
  const adapter = new DomAdapter(document);
  const planner = new WorkerPlanner();
  let selecting = false;
  const focusGuard = () => {
    if (!document.hasFocus() || document.visibilityState !== 'visible') throw new Error('게임 탭이 활성화되어 있지 않습니다.');
    if (isEditable(document.activeElement)) throw new Error('채팅·입력창에 포커스가 있습니다.');
    if (!adapter.status().inputEnabled) throw new Error('자기 게임 입력이 활성화되어 있지 않습니다.');
  };
  const keyboard = new WindowKeyboard(window, focusGuard);
  const controller = new Controller(adapter, planner, keyboard, undefined, update => {
    const plan = update.plan;
    status.textContent = `${update.state} · 표시 검증 ${update.locks}회 · 재계획 ${update.resyncs}회\n${update.message}${plan ? `\n탐색 ${plan.elapsedMs.toFixed(1)}ms · 깊이 ${plan.depth} · 노드 ${plan.nodes}` : ''}`;
  });
  function inspect(): void {
    try {
      const report = adapter.report();
      status.textContent = JSON.stringify(report, null, 2);
    } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  }
  function stop(message?: string): void { selecting = false; controller.stop(message); }
  function stopForEnvironment(message: string): void {
    // Switching to chat must not replace the startup error the user is reporting.
    if (!selecting && ['STOPPED', 'ERROR', 'PAUSED'].includes(controller.state)) return;
    const previous = controller.state;
    stop(`${message}\n직전 단계: ${previous}. 게임 화면에서 연속 실행을 눌러 재시작하세요.`);
  }
  root.addEventListener('click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    button.blur();
    if (action === 'stop') stop();
    else if (action === 'inspect') inspect();
    else if (action === 'select') { stop(); selecting = true; status.textContent = '자기 보드의 고정 셀 영역을 클릭하세요. 상대 미니 보드는 선택할 수 없습니다.'; }
    else if (action === 'export') {
      const content = controller.recorder.jsonl();
      if (!content) { status.textContent = '저장할 검증 기록이 없습니다. 관측·탐색 또는 한 수 실행 후 저장하세요.'; return; }
      const url = URL.createObjectURL(new Blob([content + '\n'], { type: 'application/x-ndjson' }));
      const a = document.createElement('a'); a.href = url; a.download = `tetris-evidence-${Date.now()}.jsonl`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (action === 'single' || action === 'continuous' || action === 'shadow') {
      selecting = false;
      void controller.start(action);
    }
  });
  root.querySelector('.min')!.addEventListener('click', () => root.querySelector('.body')!.classList.toggle('hidden'));
  document.addEventListener('click', event => {
    if (!selecting || !(event.target instanceof HTMLElement) || event.composedPath().includes(host)) return;
    event.preventDefault(); event.stopPropagation(); selecting = false;
    try { adapter.select(event.target); inspect(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  }, true);
  window.addEventListener('keydown', event => {
    if (event.code === 'F8') { event.preventDefault(); stop('F8 긴급 중지. 눌린 키를 해제했습니다.'); }
    else if (event.code === 'F9') { event.preventDefault(); inspect(); }
    else if (['ArrowLeft','ArrowRight','ArrowDown','ArrowUp','Space','KeyX','KeyZ','KeyA','KeyC'].includes(event.code) && event.isTrusted) {
      stop('직접 조작을 감지해 AI를 중지했습니다.');
    }
  }, true);
  window.addEventListener('blur', () => stopForEnvironment('탭 포커스가 사라져 중지했습니다.'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopForEnvironment('게임 탭이 숨겨져 중지했습니다.'); });
  document.addEventListener('focusin', () => { if (isEditable(document.activeElement)) stopForEnvironment('입력창 포커스로 중지했습니다.'); });
  window.addEventListener('pagehide', () => stopForEnvironment('페이지 종료로 중지했습니다.'));
}

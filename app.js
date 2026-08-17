(() => {
  const $ = (s) => document.querySelector(s);
  const screen = $('#screen');
  const netBadge = $('#netBadge');
  const DEFAULT_SERVER = 'https://just-one-online.naitoryo7110.workers.dev';
  const SESSION_KEY = 'justOneOnlineSessionV06';
  const NAME_KEY = 'justOneOnlineNameV04';

  let serverUrl = normalizeServer(DEFAULT_SERVER);
  let session = readJson(localStorage.getItem(SESSION_KEY));
  let state = null;
  let socket = null;
  let pingTimer = null;
  let fallbackTimer = null;
  let roomRefreshTimer = null;
  let busy = false;

  function readJson(value) { try { return JSON.parse(value || 'null'); } catch { return null; } }
  function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function normalizeServer(value) { return String(value || '').trim().replace(/\/+$/, ''); }
  function roomLabel(id) { return `ルーム ${String(id || '').replace('room','')}`; }
  function me() { return state?.players?.find((p) => p.id === session?.playerId) || null; }
  function playerName(id) { return state?.players?.find((p) => p.id === id)?.name || '不明'; }
  function nonGuesserPlayers() { return (state?.players || []).filter((p) => !p.isGuesser); }
  function submittedCount() { return nonGuesserPlayers().filter((p) => p.clueSubmitted).length; }
  function setNet(mode, text) { netBadge.className = `netBadge ${mode}`; netBadge.textContent = text; }
  function modeName(mode) { return mode === 'target-score' ? '目標正解数モード' : 'ラウンド数モード'; }

  function toast(text) {
    const el = $('#toast'); el.textContent = text; el.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function api(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${serverUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: { 'Content-Type':'application/json', ...(options.headers || {}) }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error('サーバー応答がありません。Workersを再デプロイしてください。');
      throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function action(type, payload = {}) {
    if (!session || busy) return;
    busy = true;
    try {
      const data = await api(`/api/room/${session.room}/action`, {
        method:'POST', body:JSON.stringify({ playerId:session.playerId, token:session.token, type, payload })
      });
      if (data.reset) { clearSession(); renderTitle(); return; }
      if (data.state) { state = data.state; renderGame(); }
      if (type === 'leave') { clearSession(); renderTitle(); }
    } catch (e) { toast(e.message); }
    finally { busy = false; }
  }

  function saveSession() { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); }
  function clearSession() {
    localStorage.removeItem(SESSION_KEY); session = null; state = null;
    closeRealtime();
  }

  function stopRoomRefresh() {
    clearInterval(roomRefreshTimer);
    roomRefreshTimer = null;
  }

  function closeRealtime() {
    if (socket) { try { socket.close(); } catch {} }
    socket = null;
    clearInterval(pingTimer); pingTimer = null;
    clearInterval(fallbackTimer); fallbackTimer = null;
    setNet('offline','未接続');
  }

  function connectRealtime() {
    if (!session || !serverUrl) return;
    closeRealtime();
    setNet('connecting','接続中');
    const wsBase = serverUrl.replace(/^http:/,'ws:').replace(/^https:/,'wss:');
    const url = `${wsBase}/api/room/${session.room}/ws?playerId=${encodeURIComponent(session.playerId)}&token=${encodeURIComponent(session.token)}`;
    try {
      socket = new WebSocket(url);
      socket.onopen = () => {
        setNet('online','接続中');
        pingTimer = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({type:'ping'}));
        }, 120000);
      };
      socket.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'state' && msg.state) { state = msg.state; renderGame(); }
          if (msg.type === 'reset') { clearSession(); renderTitle(); toast('部屋が初期化されました。'); }
        } catch {}
      };
      socket.onerror = () => startFallback();
      socket.onclose = () => startFallback();
    } catch { startFallback(); }
  }

  function startFallback() {
    if (!session) return;
    setNet('connecting','再接続中');
    if (!fallbackTimer) {
      fallbackTimer = setInterval(refreshState, 1800);
      refreshState();
    }
  }

  async function refreshState() {
    if (!session) return;
    try {
      const data = await api(`/api/room/${session.room}/state?playerId=${encodeURIComponent(session.playerId)}&token=${encodeURIComponent(session.token)}`);
      state = data.state;
      setNet('online','接続中');
      renderGame();
      if (!socket || socket.readyState === WebSocket.CLOSED) connectRealtime();
    } catch (e) {
      if (/参加情報/.test(e.message)) { clearSession(); renderTitle(); toast('部屋が初期化されました。'); }
      else setNet('offline','切断');
    }
  }

  function statusHtml() {
    if (state.mode === 'target-score') {
      return `<div class="statusbar">
        <div class="stat"><b>${state.score}/${state.modeTarget}</b><span>正解 / 目標</span></div>
        <div class="stat"><b>${state.round || '-'}</b><span>ラウンド</span></div>
        <div class="stat"><b>先取</b><span>${state.modeTarget}問正解</span></div>
      </div>`;
    }
    const remain = Math.max(0, (state.modeTarget || 0) - (state.round || 0));
    return `<div class="statusbar">
      <div class="stat"><b>${state.score}</b><span>正解</span></div>
      <div class="stat"><b>${state.round || '-'}/${state.modeTarget || '-'}</b><span>ラウンド</span></div>
      <div class="stat"><b>${remain}</b><span>残りR</span></div>
    </div>`;
  }

  function roleHtml() {
    const roles = [];
    if (state.isGuesser) roles.push('<span class="rolePill guesser">今回の回答者</span>');
    if (state.isHost) roles.push('<span class="rolePill host">ホスト</span>');
    if (state.isJudge && state.judgeId !== state.hostId) roles.push('<span class="rolePill judge">今回の代理判定役</span>');
    return roles.join(' ');
  }

  function playersHtml() {
    return `<div class="playerList">${state.players.map((p) => `<div class="playerRow">
      <div class="playerMain"><span class="dot ${p.isCpu?'cpu':(p.connected?'on':'')}"></span><span class="playerName">${esc(p.name)}</span></div>
      <div class="badges">
        ${p.isCpu?'<span class="badge cpu">CPU</span>':''}
        ${p.isHost?'<span class="badge host">ホスト</span>':''}
        ${p.isGuesser?'<span class="badge guesser">回答者</span>':''}
        ${p.isJudge && !p.isHost?'<span class="badge judge">判定役</span>':''}
        ${state.phase==='clue' && !p.isGuesser && p.clueSubmitted?'<span class="badge done">ヒント済</span>':''}
        ${state.phase==='lobby' && state.isHost && p.isCpu?`<button class="cpuRemove" data-remove-cpu="${esc(p.id)}">削除</button>`:''}
      </div>
    </div>`).join('')}</div>`;
  }

  function targetHtml() {
    return `<section class="targetCard"><div class="targetLabel">今回のお題</div><div class="targetWord">${esc(state.currentTarget || '')}</div></section>`;
  }

  function waitHtml(icon, title, text, current = null, total = null) {
    const pct = total ? Math.round((current / total) * 100) : 0;
    return `<section class="panel waiting"><div class="waitingIcon">${icon}</div><h2>${esc(title)}</h2><p class="muted">${text}</p>${total?`<div class="progressLine"><div style="width:${pct}%"></div></div><div class="muted" style="margin-top:7px;font-size:12px">${current}/${total}</div>`:''}</section>`;
  }

  function clueCardsHtml(mode) {
    return `<div class="clueGrid">${(state.clues || []).map((c) => {
      const own = c.ownerId === session.playerId;
      const canRemove = mode === 'remove' && state.canRemoveClues;
      const nextRemoved = c.removed ? 'false' : 'true';
      return `<button type="button" class="clueCard ${c.removed?'removed':''} ${canRemove?'removeable':''}" ${canRemove?`data-remove="${esc(c.ownerId)}" data-next-removed="${nextRemoved}"`: 'disabled'}>
        <div class="clueOwner">${esc(c.ownerName)}${own?'（自分）':''}</div>
        <div class="clueWord">${esc(c.text)}</div>
        ${c.removed?'<div class="removedMark">×</div>':''}
      </button>`;
    }).join('')}</div>`;
  }

  function bindClueButtons() {
    document.querySelectorAll('[data-remove]').forEach((b) => b.onclick = () => action('setRemoved',{
      targetId:b.dataset.remove, removed:b.dataset.nextRemoved === 'true'
    }));
  }

  function renderTitle() {
    closeRealtime();
    stopRoomRefresh();
    const savedName = localStorage.getItem(NAME_KEY) || '';
    screen.dataset.view = 'title';
    screen.dataset.phase = 'title';
    const top = $('#roomTopControls'); if (top) top.innerHTML = '';
    screen.innerHTML = `<div class="titleShell titleClassic">
      <section class="hero"><h1>ジャストワン</h1><p>2～10人対応オンライン協力ワードゲーム</p></section>
      <section class="panel namePanel stack">
        <label>プレイヤー名<input id="playerName" class="input" maxlength="16" value="${esc(savedName)}" placeholder="名前"></label>
      </section>
      <section class="panel roomsPanel"><h2 class="sectionTitle">部屋を選択</h2><div id="roomArea" class="roomGrid"><div class="muted">部屋情報を取得中...</div></div></section>
    </div>`;
    loadRooms();
    roomRefreshTimer = setInterval(loadRooms, 5000);
  }

  async function loadRooms() {
    const area = $('#roomArea'); if (!area) return;
    setNet('connecting','接続確認中');
    try {
      const data = await api('/api/rooms');
      setNet('online','サーバーOK');
      area.innerHTML = data.rooms.map((r) => `<div class="roomCard">
        <div class="roomTop"><div class="roomName">${roomLabel(r.id)}</div><div class="roomMeta">${r.playerCount}/${r.maxPlayers}人</div></div>
        <div class="roomPlayers">${r.players.length?esc(r.players.join('、')):'空室'}</div>
        <div class="roomMeta">${r.phase==='lobby'?'待機中':r.phase==='ended'?'結果表示中':`ゲーム中 / ${r.round}R`}</div>
        <div class="roomButtons">
          <button class="btn primary full" data-join="${r.id}" ${r.phase!=='lobby' || r.playerCount>=r.maxPlayers?'disabled':''}>${r.phase==='lobby'?'参加する':'ゲーム中'}</button>
          <button class="btn ghost full" data-public-reset="${r.id}">部屋を初期化</button>
        </div>
      </div>`).join('');
      document.querySelectorAll('[data-join]').forEach((b) => b.onclick = () => joinRoom(b.dataset.join));
      document.querySelectorAll('[data-public-reset]').forEach((b) => b.onclick = () => publicResetRoom(b.dataset.publicReset));
    } catch (e) {
      setNet('offline','接続失敗');
      area.innerHTML = `<div class="notice red">${esc(e.message)}<br>サーバーへ接続できません。</div><button id="retryServer" class="btn primary full" style="margin-top:12px">再接続</button>`;
      $('#retryServer')?.addEventListener('click', loadRooms);
    }
  }

  async function publicResetRoom(room) {
    if (!confirm(`${roomLabel(room)} を完全に初期化しますか？\n参加中のプレイヤーも全員退出扱いになります。`)) return;
    try {
      await api(`/api/room/${room}/admin-reset`, { method:'POST', body:'{}' });
      toast(`${roomLabel(room)} を初期化しました。`);
      await loadRooms();
    } catch (e) { toast(e.message); }
  }

  async function joinRoom(room) {
    const name = String($('#playerName')?.value || '').trim();
    if (!name) return toast('プレイヤー名を入力してください。');
    localStorage.setItem(NAME_KEY, name);
    stopRoomRefresh();
    try {
      const data = await api(`/api/room/${room}/join`, { method:'POST', body:JSON.stringify({name}) });
      session = { room, playerId:data.playerId, token:data.token, name, serverUrl };
      saveSession(); state = data.state; renderGame(); connectRealtime();
    } catch (e) { toast(e.message); renderTitle(); }
  }

  async function reconnect() {
    if (!session) return renderTitle();
    if (session.serverUrl) serverUrl = normalizeServer(session.serverUrl);
    try {
      const data = await api(`/api/room/${session.room}/join`, {
        method:'POST', body:JSON.stringify({ playerId:session.playerId, token:session.token, name:session.name })
      });
      state = data.state; renderGame(); connectRealtime();
    } catch {
      clearSession(); renderTitle();
    }
  }

  function lobbyModeHtml() {
    const mode = state.mode || 'rounds';
    const target = state.modeTarget || 13;
    if (!state.isHost) {
      return `<section class="panel"><h2 class="sectionTitle">ゲーム設定</h2><div class="modeSummary"><b>${esc(modeName(mode))}</b><span>${mode==='target-score'?`${target}問正解するまで`:`全${target}ラウンド`}</span></div><div class="notice">ホストが設定を変更できます。</div></section>`;
    }
    return `<section class="panel stack"><h2 class="sectionTitle">ゲーム設定</h2>
      <div class="modePicker">
        <button class="modeCard ${mode==='rounds'?'selected':''}" data-mode="rounds"><b>ラウンド数モード</b><span>決めたラウンド数を遊び、最終的な正解数を記録</span></button>
        <button class="modeCard ${mode==='target-score'?'selected':''}" data-mode="target-score"><b>目標正解数モード</b><span>決めた正解数に到達するまで、何ラウンド掛かったかを記録</span></button>
      </div>
      <label>${mode==='target-score'?'目標正解数':'ラウンド数'}
        <input id="modeTarget" class="input" type="number" min="1" max="${mode==='target-score'?30:50}" value="${target}">
      </label>
      <div class="muted">${mode==='target-score'?'1～30問で設定できます。':'1～50ラウンドで設定できます。'}</div>
    </section>`;
  }

  function renderGame() {
    if (!session || !state) return;
    stopRoomRefresh();
    const top = $('#roomTopControls');
    if (top) top.innerHTML = `${state.canReset?'<button id="topResetRoom" class="topbarBtn">初期化</button>':''}<button id="topLeaveRoom" class="topbarBtn danger">退出</button>`;

    const header = `${statusHtml()}<section class="turnHead">${roleHtml()}<div class="bigName">${esc(me()?.name || '')}</div><div class="muted">${roomLabel(session.room)} / ${esc(modeName(state.mode))}</div></section>`;
    let body = '';

    if (state.phase === 'lobby') {
      body = `${lobbyModeHtml()}<section class="panel actions lobbyActions">
        ${state.isHost?`<button id="addCpu" class="btn secondary full" ${state.players.length>=10?'disabled':''}>テストCPUを追加</button><button id="startGame" class="btn primary full" ${state.canStart?'':'disabled'}>ゲーム開始</button>`:'<div class="notice">ホストがゲームを開始するまでお待ちください。</div>'}
      </section>`;
    }

    else if (state.phase === 'clue') {
      const givers = nonGuesserPlayers();
      if (state.isGuesser) {
        body = waitHtml('🙈','あなたは今回の回答者です','お題は表示されません。全員のヒント入力を待っています。',submittedCount(),givers.length);
      } else {
        body = `${targetHtml()}<section class="panel stack">
          ${state.myClue?`<div class="notice green">ヒント送信済み：<b>${esc(state.myClue)}</b><br>他のプレイヤーの入力待ちです。</div>`:`<input id="clueInput" class="input clueInput" maxlength="20" placeholder="ヒントを1語"><button id="submitClue" class="btn primary full">ヒントを送信</button>`}
          <div class="muted center">送信済み ${submittedCount()}/${givers.length}</div>
        </section>`;
      }
    }

    else if (state.phase === 'host-review') {
      if (state.isGuesser) {
        body = waitHtml('✖️','ヒント削除タイムです','削除が終わるまで、回答者にはヒントは表示されません。');
      } else {
        body = `${targetHtml()}<section class="panel stack clueReviewPanel"><div class="notice red">削除するヒントをタップすると × が付きます。もう一度タップすると取り消せます。</div>${clueCardsHtml('remove')}${state.canPublishClues?'<button id="publishClues" class="btn primary full">削除確定 → 回答者へ公開</button>':'<div class="muted center publishWait">削除確定は判定役が行います。</div>'}</section>`;
      }
    }

    else if (state.phase === 'guess') {
      if (state.isGuesser) {
        body = `<section class="panel stack guessPanel"><div class="notice blue">残ったヒントだけが公開されています。</div>${clueCardsHtml('guess')}<input id="answerInput" class="input answerBig" maxlength="30" placeholder="回答"><div class="actions two"><button id="submitAnswer" class="btn primary">回答する</button><button id="pass" class="btn ghost">パス</button></div></section>`;
      } else {
        body = `${targetHtml()}<section class="panel stack"><div class="notice">回答者の回答を待っています。</div>${clueCardsHtml('readonly')}</section>`;
      }
    }

    else if (state.phase === 'answer-review') {
      if (state.isGuesser) {
        body = waitHtml('⌛','判定待ちです',`${esc(playerName(state.judgeId))} が回答を判定しています。`);
      } else if (state.canJudgeAnswer) {
        body = `${targetHtml()}<section class="panel stack"><div class="muted center">回答</div><div class="answerBig">${esc(state.answer)}</div><div class="actions two"><button id="judgeCorrect" class="btn good">正解</button><button id="judgeWrong" class="btn bad">不正解</button></div></section>`;
      } else {
        body = `${targetHtml()}<section class="panel stack"><div class="muted center">回答</div><div class="answerBig">${esc(state.answer)}</div><div class="notice">${esc(playerName(state.judgeId))} の判定待ちです。</div></section>`;
      }
    }

    else if (state.phase === 'result') {
      const resultText = state.result === 'correct' ? '正解！' : state.result === 'pass' ? 'パス' : '不正解';
      const mark = state.result === 'correct' ? '⭕' : state.result === 'pass' ? '⏭️' : '❌';
      body = `<section class="panel stack center"><div class="resultMark">${mark}</div><h2>${resultText}</h2><div class="muted">お題</div><div class="answerBig">${esc(state.currentTarget || '')}</div>${state.answer?`<div class="muted">回答：${esc(state.answer)}</div>`:''}</section>
      <section class="panel actions">${state.canNextRound?`<button id="nextRound" class="btn primary full">${state.endPending?'最終結果を見る':'次のラウンド'}</button>`:'<div class="notice">ホストが進行します。</div>'}</section>`;
    }

    else if (state.phase === 'ended') {
      const fixed = state.mode === 'rounds';
      body = `<section class="panel stack center"><div class="muted">ゲーム終了</div>
        <div class="finalMode">${esc(modeName(state.mode))}</div>
        ${fixed?`<div class="scoreBig">${state.score}</div><div class="muted">${state.modeTarget}ラウンド中 ${state.score}問正解</div>`:`<div class="scoreBig">${state.round}</div><div class="muted">${state.modeTarget}問正解まで ${state.round}ラウンド</div>`}
        ${state.isHost?'<div class="actions two"><button id="restartSame" class="btn primary">同じ設定でもう一度</button><button id="backLobby" class="btn ghost">設定を変える</button></div>':''}
      </section>`;
    }

    screen.dataset.view = 'game';
    screen.dataset.phase = state.phase;
    screen.innerHTML = `<div class="gameShell"><div class="gameHeader">${header}</div><div class="phaseArea">${body}</div><aside class="gameSide"><section class="panel playersPanel"><div class="playersHead"><h2 class="sectionTitle">プレイヤー</h2><span class="roomCount">${state.players.length}/10</span></div>${playersHtml()}</section></aside></div>`;
    bindCurrentScreen();
  }

  function bindCurrentScreen() {
    bindClueButtons();
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    document.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => action('setMode',{mode:b.dataset.mode}));
    const modeTarget = $('#modeTarget');
    if (modeTarget) modeTarget.onchange = () => action('setModeTarget',{target:Number(modeTarget.value)});
    on('#addCpu', () => action('addCpu'));
    document.querySelectorAll('[data-remove-cpu]').forEach((b) => b.onclick = () => action('removeCpu',{cpuId:b.dataset.removeCpu}));
    on('#startGame', () => action('start'));
    on('#submitClue', () => { const v = $('#clueInput').value.trim(); if (!v) return toast('ヒントを入力してください。'); action('submitClue',{clue:v}); });
    on('#publishClues', () => action('publishClues'));
    on('#submitAnswer', () => { const v = $('#answerInput').value.trim(); if (!v) return toast('回答を入力してください。'); action('submitAnswer',{answer:v}); });
    on('#pass', () => action('pass'));
    on('#judgeCorrect', () => action('judgeAnswer',{result:'correct'}));
    on('#judgeWrong', () => action('judgeAnswer',{result:'wrong'}));
    on('#nextRound', () => action('nextRound'));
    on('#restartSame', () => action('restartSame'));
    on('#backLobby', () => action('backToLobby'));
    on('#topLeaveRoom', () => { if (confirm(state.phase === 'lobby' ? '部屋から退出しますか？' : 'マッチから退出しますか？')) action('leave'); });
    on('#topResetRoom', () => {
      if (confirm('この部屋を完全に初期化しますか？参加者も全員退出扱いになります。')) action('reset',{keepPlayers:false});
    });
    const clue = $('#clueInput'); if (clue) clue.addEventListener('keydown',(e)=>{if(e.key==='Enter') $('#submitClue')?.click();});
    const ans = $('#answerInput'); if (ans) ans.addEventListener('keydown',(e)=>{if(e.key==='Enter') $('#submitAnswer')?.click();});
  }


  if (session) reconnect(); else renderTitle();
})();

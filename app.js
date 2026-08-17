(() => {
  const $ = (s) => document.querySelector(s);
  const screen = $('#screen');
  const modal = $('#modal');
  const modalBody = $('#modalBody');
  const netBadge = $('#netBadge');
  const DEFAULT_SERVER = 'https://just-one-online.naitoryo7110.workers.dev';
  const SESSION_KEY = 'justOneOnlineSessionV04';
  const SERVER_KEY = 'justOneOnlineServerV04';
  const NAME_KEY = 'justOneOnlineNameV04';

  let serverUrl = normalizeServer(localStorage.getItem(SERVER_KEY) || DEFAULT_SERVER);
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
  function voteDoneCount() { return nonGuesserPlayers().filter((p) => p.voteDone).length; }
  function setNet(mode, text) { netBadge.className = `netBadge ${mode}`; netBadge.textContent = text; }
  function modeName(mode) { return mode === 'target-score' ? '目標正解数モード' : 'ラウンド数モード'; }

  function toast(text) {
    const el = $('#toast'); el.textContent = text; el.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function api(path, options = {}) {
    const res = await fetch(`${serverUrl}${path}`, {
      ...options,
      headers: { 'Content-Type':'application/json', ...(options.headers || {}) }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
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
      <div class="playerMain"><span class="dot ${p.connected?'on':''}"></span><span class="playerName">${esc(p.name)}</span></div>
      <div class="badges">
        ${p.isHost?'<span class="badge host">ホスト</span>':''}
        ${p.isGuesser?'<span class="badge guesser">回答者</span>':''}
        ${p.isJudge && !p.isHost?'<span class="badge judge">判定役</span>':''}
        ${state.phase==='clue' && !p.isGuesser && p.clueSubmitted?'<span class="badge done">ヒント済</span>':''}
        ${state.phase==='vote' && !p.isGuesser && p.voteDone?'<span class="badge done">確認済</span>':''}
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
      const voterLocked = state.voteDone;
      const showVotes = mode !== 'guess';
      const canVote = mode === 'vote' && !own && !voterLocked;
      const canRemove = mode === 'review' && state.canJudgeClues;
      return `<div class="clueCard ${c.myVote?'flagged':''} ${c.removed?'removed':''}">
        <div class="clueOwner">${esc(c.ownerName)}${own?'（自分）':''}</div>
        ${canVote?`<button class="xButton ${c.myVote?'on':''}" data-vote="${esc(c.ownerId)}">×</button>`:''}
        <div class="clueWord">${esc(c.text)}</div>
        ${showVotes?`<div class="voteInfo">${c.voteNames?.length?`× ${c.voteNames.length}：${esc(c.voteNames.join('、'))}`:'× 0'}</div>`:''}
        ${canRemove?`<button class="removeButton ${c.removed?'on':''}" data-remove="${esc(c.ownerId)}">${c.removed?'除去中・戻す':'このヒントを除去'}</button>`:''}
      </div>`;
    }).join('')}</div>`;
  }

  function bindClueButtons() {
    document.querySelectorAll('[data-vote]').forEach((b) => b.onclick = () => action('toggleVote',{targetId:b.dataset.vote}));
    document.querySelectorAll('[data-remove]').forEach((b) => b.onclick = () => action('toggleRemoved',{targetId:b.dataset.remove}));
  }

  function renderTitle() {
    closeRealtime();
    stopRoomRefresh();
    const savedName = localStorage.getItem(NAME_KEY) || '';
    screen.innerHTML = `
      <section class="hero"><h1>ジャストワン</h1><p>2～10人対応オンライン協力ワードゲーム。<br>ヒントの×提案と最終除去はプレイヤー同士で行います。</p></section>
      <section class="panel stack">
        <label>プレイヤー名<input id="playerName" class="input" maxlength="16" value="${esc(savedName)}" placeholder="名前"></label>
        <div class="serverFixed">接続先：${esc(serverUrl)}</div>
      </section>
      <section class="panel"><h2 class="sectionTitle">部屋を選択</h2><div id="roomArea" class="roomGrid"><div class="muted">部屋情報を取得中...</div></div></section>`;
    loadRooms();
    roomRefreshTimer = setInterval(loadRooms, 5000);
  }

  async function loadRooms() {
    const area = $('#roomArea'); if (!area) return;
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
      area.innerHTML = `<div class="notice red">${esc(e.message)}<br>サーバーへ接続できません。</div>`;
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
    const header = `${statusHtml()}<section class="turnHead">${roleHtml()}<div class="bigName">${esc(me()?.name || '')}</div><div class="muted">${roomLabel(session.room)} / ${esc(modeName(state.mode))}</div></section>`;
    let body = '';

    if (state.phase === 'lobby') {
      body = `${lobbyModeHtml()}<section class="panel"><h2 class="sectionTitle">参加者 ${state.players.length}/10</h2>${playersHtml()}</section>
      <section class="panel actions">
        ${state.isHost?`<button id="startGame" class="btn primary full" ${state.canStart?'':'disabled'}>ゲーム開始</button>`:'<div class="notice">ホストがゲームを開始するまでお待ちください。</div>'}
        <button id="leaveRoom" class="btn ghost full">部屋から退出</button>
      </section>`;
    }

    else if (state.phase === 'clue') {
      const givers = nonGuesserPlayers();
      if (state.isGuesser) {
        body = waitHtml('🙈','あなたは今回の回答者です','お題は表示されません。全員のヒント入力を待っています。',submittedCount(),givers.length);
      } else {
        body = `${targetHtml()}<section class="panel stack">
          ${state.myClue?`<div class="notice green">ヒント送信済み：<b>${esc(state.myClue)}</b><br>全員の入力が終わるまでお待ちください。</div>`:`<div class="notice blue">他の人と相談せず、このお題を連想できるヒントを1語で入力してください。</div><input id="clueInput" class="input clueInput" maxlength="20" placeholder="ヒントを1語"><button id="submitClue" class="btn primary full">ヒントを送信</button>`}
          <div class="muted center">送信済み ${submittedCount()}/${givers.length}</div>
        </section>`;
      }
    }

    else if (state.phase === 'vote') {
      const givers = nonGuesserPlayers();
      if (state.isGuesser) {
        body = waitHtml('✖️','ヒント確認中です','回答者にはヒントも×投票もまだ表示されません。',voteDoneCount(),givers.length);
      } else {
        body = `${targetHtml()}<section class="panel stack"><div class="notice">「このヒントはダメでは？」と思うものに×を付けられます。×が付いても自動では消えません。自分のヒントには×を付けられません。</div>${clueCardsHtml('vote')}${state.voteDone?'<div class="notice green">確認完了済みです。他のプレイヤーを待っています。</div>':'<button id="voteDone" class="btn primary full">×確認完了</button>'}<div class="muted center">確認済み ${voteDoneCount()}/${givers.length}</div></section>`;
      }
    }

    else if (state.phase === 'host-review') {
      if (state.isGuesser) {
        body = waitHtml('🧑‍⚖️','ヒント除去中です',`${esc(playerName(state.judgeId))} が最終確認しています。除去確定後にヒントが公開されます。`);
      } else if (state.canJudgeClues) {
        body = `${targetHtml()}<section class="panel stack"><div class="notice red">×票は参考情報です。最終的に無効にするヒントを手動で選んでください。</div>${clueCardsHtml('review')}<button id="publishClues" class="btn primary full">除去確定 → 回答者へヒント公開</button></section>`;
      } else {
        body = `${targetHtml()}<section class="panel stack"><div class="notice">${esc(playerName(state.judgeId))} がヒントの最終除去をしています。</div>${clueCardsHtml('readonly')}</section>`;
      }
    }

    else if (state.phase === 'guess') {
      if (state.isGuesser) {
        body = `<section class="panel stack"><div class="notice blue">有効なヒントだけが公開されました。お題を予想してください。</div>${clueCardsHtml('guess')}<input id="answerInput" class="input answerBig" maxlength="30" placeholder="回答"><div class="actions two"><button id="submitAnswer" class="btn primary">回答する</button><button id="pass" class="btn ghost">パス</button></div></section>`;
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

    screen.innerHTML = `${header}${body}<section class="panel"><h2 class="sectionTitle">プレイヤー</h2>${playersHtml()}${state.canReset?'<div style="margin-top:12px"><button id="resetRoom" class="btn ghost full">部屋を初期化</button></div>':''}</section>`;
    bindCurrentScreen();
  }

  function bindCurrentScreen() {
    bindClueButtons();
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
    document.querySelectorAll('[data-mode]').forEach((b) => b.onclick = () => action('setMode',{mode:b.dataset.mode}));
    const modeTarget = $('#modeTarget');
    if (modeTarget) modeTarget.onchange = () => action('setModeTarget',{target:Number(modeTarget.value)});
    on('#startGame', () => action('start'));
    on('#leaveRoom', () => action('leave'));
    on('#submitClue', () => { const v = $('#clueInput').value.trim(); if (!v) return toast('ヒントを入力してください。'); action('submitClue',{clue:v}); });
    on('#voteDone', () => action('voteDone'));
    on('#publishClues', () => action('publishClues'));
    on('#submitAnswer', () => { const v = $('#answerInput').value.trim(); if (!v) return toast('回答を入力してください。'); action('submitAnswer',{answer:v}); });
    on('#pass', () => action('pass'));
    on('#judgeCorrect', () => action('judgeAnswer',{result:'correct'}));
    on('#judgeWrong', () => action('judgeAnswer',{result:'wrong'}));
    on('#nextRound', () => action('nextRound'));
    on('#restartSame', () => action('restartSame'));
    on('#backLobby', () => action('backToLobby'));
    on('#resetRoom', () => {
      if (confirm('この部屋を完全に初期化しますか？参加者も全員退出扱いになります。')) action('reset',{keepPlayers:false});
    });
    const clue = $('#clueInput'); if (clue) clue.addEventListener('keydown',(e)=>{if(e.key==='Enter') $('#submitClue')?.click();});
    const ans = $('#answerInput'); if (ans) ans.addEventListener('keydown',(e)=>{if(e.key==='Enter') $('#submitAnswer')?.click();});
  }

  $('#rulesBtn').onclick = () => {
    modalBody.innerHTML = `<h2>遊び方</h2><ol>
      <li>2～10人で同じ部屋に参加し、ホストがゲームモードを設定します。</li>
      <li><b>ラウンド数モード</b>は指定ラウンド終了時の正解数を記録します。</li>
      <li><b>目標正解数モード</b>は指定した正解数に到達するまでのラウンド数を記録します。</li>
      <li>各ラウンドで回答者が1人決まり、回答者以外にだけランダムなお題が表示されます。</li>
      <li>回答者以外は各自1語のヒントを送信します。</li>
      <li>全ヒント公開後、各プレイヤーは怪しいヒントへ×を付けられます。自動除去はありません。</li>
      <li>全員の確認後、ホストが×票を参考にヒントを手動除去します。ホストが回答者の回だけ代理判定役が担当します。</li>
      <li>残ったヒントだけ回答者へ公開し、回答後に判定役が正解・不正解を判定します。</li>
      <li>不正解やパスでも1ラウンド終了です。追加で問題を失う処理はありません。</li>
    </ol><p class="muted">お題語彙は市販版の収録カードをコピーせず、オリジナル語彙を使用しています。</p>`;
    modal.showModal();
  };

  if (session) reconnect(); else renderTitle();
})();

(() => {
  const $ = (s) => document.querySelector(s);
  const screen = $('#screen');
  const modal = $('#modal');
  const modalBody = $('#modalBody');
  const netBadge = $('#netBadge');
  const SESSION_KEY = 'justOneOnlineSessionV03';
  const SERVER_KEY = 'justOneOnlineServerV03';
  const NAME_KEY = 'justOneOnlineNameV03';

  let serverUrl = normalizeServer(localStorage.getItem(SERVER_KEY) || '');
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
  function roomLabel(id) { const n = String(id || '').replace('room',''); return `ルーム ${n}`; }
  function me() { return state?.players?.find((p) => p.id === session?.playerId) || null; }
  function playerName(id) { return state?.players?.find((p) => p.id === id)?.name || '不明'; }
  function nonGuesserPlayers() { return (state?.players || []).filter((p) => !p.isGuesser); }
  function submittedCount() { return nonGuesserPlayers().filter((p) => p.clueSubmitted).length; }
  function voteDoneCount() { return nonGuesserPlayers().filter((p) => p.voteDone).length; }
  function setNet(mode, text) { netBadge.className = `netBadge ${mode}`; netBadge.textContent = text; }

  function toast(text) {
    const el = $('#toast'); el.textContent = text; el.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function api(path, options = {}) {
    if (!serverUrl) throw new Error('Cloudflare Workers のURLを設定してください。');
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
    return `<div class="statusbar">
      <div class="stat"><b>${state.score}</b><span>正解</span></div>
      <div class="stat"><b>${state.remaining}</b><span>残り</span></div>
      <div class="stat"><b>${state.round || '-'}</b><span>ラウンド</span></div>
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
    const savedName = localStorage.getItem(NAME_KEY) || '';
    screen.innerHTML = `
      <section class="hero"><h1>ひとことヒント</h1><p>2～10人対応のオンライン協力ワードゲーム。<br>回答者以外がヒントを書き、×で意見を出し、最後はホストが手動で除去します。</p></section>
      <section class="panel stack">
        <label>Cloudflare Workers URL
          <div class="serverRow"><input id="serverUrl" class="input" placeholder="https://xxxxx.workers.dev" value="${esc(serverUrl)}"><button id="saveServer" class="btn ghost">接続確認</button></div>
        </label>
        <label>プレイヤー名<input id="playerName" class="input" maxlength="16" value="${esc(savedName)}" placeholder="名前"></label>
      </section>
      <section class="panel"><h2 class="sectionTitle">部屋を選択</h2><div id="roomArea" class="roomGrid"><div class="muted">サーバーURLを設定すると部屋情報を取得します。</div></div></section>`;

    $('#saveServer').onclick = async () => {
      serverUrl = normalizeServer($('#serverUrl').value);
      localStorage.setItem(SERVER_KEY, serverUrl);
      await loadRooms();
    };
    if (serverUrl) loadRooms();
  }

  async function loadRooms() {
    const area = $('#roomArea'); if (!area) return;
    serverUrl = normalizeServer($('#serverUrl')?.value || serverUrl);
    localStorage.setItem(SERVER_KEY, serverUrl);
    if (!serverUrl) { area.innerHTML = '<div class="muted">サーバーURLを入力してください。</div>'; return; }
    area.innerHTML = '<div class="muted">部屋情報を取得中...</div>';
    try {
      const data = await api('/api/rooms');
      setNet('online','サーバーOK');
      area.innerHTML = data.rooms.map((r) => `<div class="roomCard">
        <div class="roomTop"><div class="roomName">${roomLabel(r.id)}</div><div class="roomMeta">${r.playerCount}/${r.maxPlayers}人</div></div>
        <div class="roomPlayers">${r.players.length?esc(r.players.join('、')):'空室'}</div>
        <div class="roomMeta">${r.phase==='lobby'?'待機中':`ゲーム中 / ${r.round}R`}</div>
        <button class="btn primary full" data-join="${r.id}" ${r.phase!=='lobby' || r.playerCount>=r.maxPlayers?'disabled':''}>${r.phase==='lobby'?'参加する':'ゲーム中'}</button>
      </div>`).join('');
      document.querySelectorAll('[data-join]').forEach((b) => b.onclick = () => joinRoom(b.dataset.join));
    } catch (e) {
      setNet('offline','接続失敗');
      area.innerHTML = `<div class="notice red">${esc(e.message)}<br>Workers URLを確認してください。</div>`;
    }
  }

  async function joinRoom(room) {
    const name = String($('#playerName')?.value || '').trim();
    if (!name) return toast('プレイヤー名を入力してください。');
    localStorage.setItem(NAME_KEY, name);
    try {
      const data = await api(`/api/room/${room}/join`, { method:'POST', body:JSON.stringify({name}) });
      session = { room, playerId:data.playerId, token:data.token, name, serverUrl };
      saveSession(); state = data.state; renderGame(); connectRealtime();
    } catch (e) { toast(e.message); }
  }

  async function reconnect() {
    if (!session) return renderTitle();
    if (session.serverUrl) { serverUrl = normalizeServer(session.serverUrl); localStorage.setItem(SERVER_KEY,serverUrl); }
    try {
      const data = await api(`/api/room/${session.room}/join`, {
        method:'POST', body:JSON.stringify({ playerId:session.playerId, token:session.token, name:session.name })
      });
      state = data.state; renderGame(); connectRealtime();
    } catch {
      clearSession(); renderTitle();
    }
  }

  function renderGame() {
    if (!session || !state) return;
    const header = `${statusHtml()}<section class="turnHead">${roleHtml()}<div class="bigName">${esc(me()?.name || '')}</div><div class="muted">${roomLabel(session.room)}</div></section>`;
    let body = '';

    if (state.phase === 'lobby') {
      body = `<section class="panel"><h2 class="sectionTitle">参加者 ${state.players.length}/10</h2>${playersHtml()}</section>
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
      <section class="panel actions">${state.canNextRound?'<button id="nextRound" class="btn primary full">次のラウンド</button>':'<div class="notice">ホストが次のラウンドへ進めます。</div>'}</section>`;
    }

    else if (state.phase === 'ended') {
      body = `<section class="panel stack center"><div class="muted">ゲーム終了</div><div class="scoreBig">${state.score}</div><div class="muted">/ 13 点</div>${state.isHost?'<button id="sameMembers" class="btn primary full">同じメンバーでもう一度</button>':''}</section>`;
    }

    screen.innerHTML = `${header}${body}<section class="panel"><h2 class="sectionTitle">プレイヤー</h2>${playersHtml()}${state.canReset?'<div style="margin-top:12px"><button id="resetRoom" class="btn ghost full">部屋を初期化</button></div>':''}</section>`;
    bindCurrentScreen();
  }

  function bindCurrentScreen() {
    bindClueButtons();
    const on = (id, fn) => { const el = $(id); if (el) el.onclick = fn; };
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
    on('#sameMembers', async () => { await action('reset',{keepPlayers:true}); await action('start'); });
    on('#resetRoom', () => {
      if (confirm('この部屋を完全に初期化しますか？参加者も全員退出扱いになります。')) action('reset',{keepPlayers:false});
    });
    const clue = $('#clueInput'); if (clue) clue.addEventListener('keydown',(e)=>{if(e.key==='Enter') $('#submitClue')?.click();});
    const ans = $('#answerInput'); if (ans) ans.addEventListener('keydown',(e)=>{if(e.key==='Enter') $('#submitAnswer')?.click();});
  }

  $('#rulesBtn').onclick = () => {
    modalBody.innerHTML = `<h2>遊び方</h2><ol>
      <li>2～10人で同じ部屋に参加し、ホストがゲームを開始します。</li>
      <li>各ラウンドで回答者が1人決まります。番号選択はありません。</li>
      <li>サーバーがランダムなお題を1つ決め、回答者以外にだけ表示します。</li>
      <li>回答者以外は各自1語のヒントを送信します。</li>
      <li>全員のヒント送信後、回答者以外に全ヒントを公開します。</li>
      <li>各プレイヤーは「このヒントは無効では？」と思う他人のヒントへ×を付けられます。自動除去はありません。</li>
      <li>全員の確認後、ホストが×票を参考にヒントを手動除去します。ホストが回答者の回だけ、回答者以外の1人が代理判定役になります。</li>
      <li>除去確定後、残ったヒントだけを回答者へ公開します。</li>
      <li>回答者が回答し、判定役が正解・不正解を判定します。</li>
    </ol><p class="muted">お題語彙は市販版の収録カードをコピーせず、オリジナル語彙を使用しています。</p>`;
    modal.showModal();
  };

  if (session) reconnect(); else renderTitle();
})();

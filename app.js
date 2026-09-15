(() => {
  const $ = (s) => document.querySelector(s);
  const screen = $('#screen');
  const netBadge = $('#netBadge');

  const GAME_ID = 'just-one';
  const GAME_NAME = 'ジャストワン';
  const MAX_PLAYERS = 10;
  const WORKER_ORIGIN = 'https://just-one-online.naitoryo7110.workers.dev';
  const COMMON_MANAGER_URL = 'https://boardgame-hub-api.naitoryo7110.workers.dev';
  const COMMON_PLAYER_NAME_KEY = 'boardgamePlayerName';
  const ROOM_IDS = ['room1', 'room2', 'room3', 'room4'];
  const APP_VERSION = 'v0.14';

  const SESSION_KEY = `${GAME_ID}-online-session`;
  const LEGACY_SESSION_KEY = 'justOneOnlineSessionV06';
  const NAME_DRAFT_KEY = `${GAME_ID}-online-name-draft`;
  const ACTIVE_ROOM_KEY = `${GAME_ID}-online-room`;
  const ACTIVE_NAME_KEY = `${GAME_ID}-online-active-name`;

  let serverUrl = normalizeServer(WORKER_ORIGIN);
  let session = readJson(localStorage.getItem(SESSION_KEY)) || readJson(localStorage.getItem(LEGACY_SESSION_KEY));
  let state = null;
  let socket = null;
  let pingTimer = null;
  let fallbackTimer = null;
  let roomRefreshTimer = null;
  let busy = false;
  let commonNameSavedForSession = null;
  let actionSeq = 0;
  let answerDraft = '';

  let topicCache = [];

  function renderTopicList() {
    const list = $('#topicList');
    const count = $('#topicCount');
    const search = String($('#topicSearch')?.value || '').trim().toLowerCase();
    if (!list) return;
    const filtered = search
      ? topicCache.filter((word) => String(word).toLowerCase().includes(search))
      : topicCache;
    if (count) count.textContent = `${topicCache.length}件${search ? ` / 表示 ${filtered.length}件` : ''}`;
    list.innerHTML = filtered.length
      ? filtered.map((word) => `<div class="topicItem"><span class="topicWord">${esc(word)}</span><button type="button" class="topicDelete" data-topic-delete="${esc(word)}">削除</button></div>`).join('')
      : '<div class="topicEmpty">該当するお題がありません。</div>';
    document.querySelectorAll('[data-topic-delete]').forEach((button) => {
      button.onclick = async () => {
        const word = button.dataset.topicDelete || '';
        if (!word || !confirm(`「${word}」をお題リストから削除しますか？`)) return;
        await updateTopicList('delete', word);
      };
    });
  }

  async function loadTopicList() {
    const list = $('#topicList');
    const count = $('#topicCount');
    const editor = $('#topicEditor');
    const permission = $('#topicPermission');

    if (editor) editor.hidden = false;
    if (count) count.textContent = '読み込み中...';
    if (list) list.innerHTML = '<div class="muted">読み込み中...</div>';
    if (permission) permission.textContent = '追加・削除した内容は全ROOM共通で保存され、次に開始するゲームから反映されます。';

    try {
      const data = await apiGet('/api/topics');
      topicCache = Array.isArray(data.topics) ? data.topics : [];
      renderTopicList();
    } catch (e) {
      topicCache = [];
      if (count) count.textContent = '読み込み失敗';
      if (list) list.innerHTML = `<div class="notice red">${esc(e.message)}</div>`;
      if (permission) permission.textContent = 'お題リストを読み込めませんでした。';
    }
  }

  async function updateTopicList(actionName, word) {
    try {
      const data = await api('/api/topics', {
        method:'POST',
        body:JSON.stringify({ action:actionName, word })
      });
      topicCache = Array.isArray(data.topics) ? data.topics : topicCache;
      const addInput = $('#topicAddInput');
      if (actionName === 'add' && addInput) addInput.value = '';
      renderTopicList();
      toast(actionName === 'add' ? 'お題を追加しました。' : 'お題を削除しました。');
    } catch (e) { toast(e.message); }
  }

  function openTopicModal() {
    const modal = $('#topicModal');
    if (!modal) return;
    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
    const search = $('#topicSearch');
    if (search) search.value = '';
    loadTopicList();
  }

  function closeTopicModal() {
    const modal = $('#topicModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
  }

  function captureAnswerDraft() {
    const input = document.querySelector('#answerInput');
    if (input) answerDraft = input.value;
  }

  function readJson(value) { try { return JSON.parse(value || 'null'); } catch { return null; } }
  function esc(value) { return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function normalizeServer(value) { return String(value || '').trim().replace(/\/+$/, ''); }
  function roomLabel(id) { return `ROOM ${String(id || '').replace('room','')}`; }
  function me() { return state?.players?.find((p) => p.id === session?.playerId) || null; }
  function playerName(id) { return state?.players?.find((p) => p.id === id)?.name || '不明'; }
  function nonGuesserPlayers() { return (state?.players || []).filter((p) => !p.isGuesser); }
  function submittedCount() { return nonGuesserPlayers().filter((p) => p.clueSubmitted).length; }
  function setNet(mode, text) { netBadge.className = `netBadge ${mode}`; netBadge.textContent = text; }
  function modeName(mode) { return mode === 'target-score' ? '目標正解数モード' : 'ラウンド数モード'; }

  function commonSavedName() {
    return String(localStorage.getItem(COMMON_PLAYER_NAME_KEY) || '').trim().slice(0, 32);
  }

  function saveCommonNameOnActualStart(playerName) {
    const name = String(playerName || '').trim().slice(0, 32);
    if (!name) return;
    localStorage.setItem(COMMON_PLAYER_NAME_KEY, name);
  }

  function tokenKey(roomId) {
    return `${GAME_ID}-online-token-${roomId}`;
  }

  function getToken(roomId) {
    let token = localStorage.getItem(tokenKey(roomId));
    if (!token) {
      token = crypto.randomUUID().replace(/-/g, '');
      localStorage.setItem(tokenKey(roomId), token);
    }
    return token;
  }

  function storedToken(roomId) {
    return String(localStorage.getItem(tokenKey(roomId)) || '').trim();
  }

  function newActionId(prefix = 'op') {
    actionSeq = (actionSeq + 1) % 1000000;
    return [prefix, Date.now(), actionSeq, Math.random().toString(36).slice(2, 8)].join('-');
  }

  function roomStatusLabel(room) {
    if (room.status === 'playing') return 'ゲーム中';
    if (room.status === 'finished') return '終了';
    return '待機中';
  }

  function toast(text) {
    const el = $('#toast'); el.textContent = text; el.classList.add('show');
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.remove('show'), 2200);
  }

  async function apiGet(path) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${serverUrl}${path}`, {
        method:'GET',
        cache:'no-store',
        signal:controller.signal
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    } catch (e) {
      if (e?.name === 'AbortError') throw new Error('お題リストの読み込みがタイムアウトしました。Workersを更新してください。');
      throw e;
    } finally {
      clearTimeout(timeout);
    }
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
        method:'POST', body:JSON.stringify({ playerId:session.playerId, token:session.token, type, payload, actionId:newActionId(type) })
      });
      if (data.reset) { clearSession(); renderTitle(); return; }
      if (data.state) { state = data.state; renderGame(); }
      if (type === 'leave') { clearSession(); renderTitle(); }
    } catch (e) { toast(e.message); }
    finally { busy = false; }
  }

  function saveSession() {
    if (!session) return;
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    localStorage.removeItem(LEGACY_SESSION_KEY);
    if (session.room) localStorage.setItem(ACTIVE_ROOM_KEY, session.room);
    if (session.name) localStorage.setItem(ACTIVE_NAME_KEY, session.name);
    if (session.room && session.token) localStorage.setItem(tokenKey(session.room), session.token);
  }
  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(LEGACY_SESSION_KEY);
    localStorage.removeItem(ACTIVE_ROOM_KEY);
    localStorage.removeItem(ACTIVE_NAME_KEY);
    session = null; state = null; commonNameSavedForSession = null;
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

  function onRoomStateReceived(roomState) {
    if (!roomState || !session) return;
    const started = roomState.status === 'playing' || roomState.gameStarted === true;
    const sessionId = roomState.gameSessionId || null;
    if (started && sessionId && commonNameSavedForSession !== sessionId) {
      const currentName = roomState.players?.find((p) => p.id === session.playerId)?.name || session.name;
      saveCommonNameOnActualStart(currentName);
      commonNameSavedForSession = sessionId;
    }
  }

  function scheduleReconnect() {
    if (!session) return;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      startFallback();
      connectRealtime();
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
    const revealOriginal = mode === 'result';
    return `<div class="clueGrid">${(state.clues || []).map((c) => {
      const own = c.ownerId === session.playerId;
      const canRemove = mode === 'remove' && state.canRemoveClues;
      const nextRemoved = c.removed ? 'false' : 'true';
      const maskedRemoved = !revealOriginal && c.removed && (c.maskedByRemoval || !c.text);
      const removalClass = c.removed ? (revealOriginal ? 'resultRemoved' : 'removed') : '';
      const removalMark = c.removed
        ? (revealOriginal
          ? '<div class="resultRemovedBadge">削除されていたヒント</div>'
          : '<div class="removedMark" aria-label="削除されたヒント">×</div>')
        : '';
      return `<button type="button" class="clueCard ${removalClass} ${maskedRemoved?'maskedRemoved':''} ${canRemove?'removeable':''}" ${canRemove?`data-remove="${esc(c.ownerId)}" data-next-removed="${nextRemoved}"`: 'disabled'}>
        <div class="clueOwner">${esc(c.ownerName)}${own?'（自分）':''}</div>
        <div class="clueWord">${maskedRemoved?'&nbsp;':esc(c.text)}</div>
        ${removalMark}
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
    const savedName = sessionStorage.getItem(NAME_DRAFT_KEY) ?? commonSavedName() ?? '';
    screen.dataset.view = 'title';
    screen.dataset.phase = 'title';
    const top = $('#roomTopControls'); if (top) top.innerHTML = '';
    screen.innerHTML = `<div class="titleShell titleClassic">
      <section class="hero"><h1>${GAME_NAME}</h1><p>2～${MAX_PLAYERS}人対応オンライン協力ワードゲーム</p></section>
      <section class="panel namePanel stack">
        <label>プレイヤー名<input id="playerName" class="input" maxlength="16" value="${esc(savedName)}" placeholder="名前"></label>
      </section>
      <section class="panel roomsPanel"><h2 class="sectionTitle">部屋を選択</h2><div id="roomArea" class="roomGrid"><div class="muted">部屋情報を取得中...</div></div></section>
    </div>`;
    $('#playerName')?.addEventListener('input', (event) => {
      sessionStorage.setItem(NAME_DRAFT_KEY, event.target.value);
    });
    loadRooms();
    roomRefreshTimer = setInterval(loadRooms, 5000);
  }

  async function loadRooms() {
    const area = $('#roomArea'); if (!area) return;
    setNet('connecting','接続確認中');
    try {
      const data = await api('/api/rooms');
      setNet('online','サーバーOK');
      const roomMap = new Map((data.rooms || []).map((room) => [room.id, room]));
      area.innerHTML = ROOM_IDS.map((roomId, index) => {
        const r = roomMap.get(roomId) || { id:roomId, playerCount:0, maxPlayers:MAX_PLAYERS, players:[], status:'lobby' };
        const status = r.status || (r.phase === 'lobby' ? 'lobby' : r.phase === 'ended' ? 'finished' : 'playing');
        return `<div class="roomCard">
          <div class="roomTop"><div class="roomName">ROOM ${index + 1}</div><div class="roomMeta">${r.playerCount}/${r.maxPlayers ?? MAX_PLAYERS}人</div></div>
          <div class="roomPlayers">参加者：${r.players?.length ? esc(r.players.join('、')) : 'なし'}</div>
          <div class="roomMeta">${roomStatusLabel({status})}</div>
          <div class="roomButtons">
            <button class="btn primary full" data-join="${roomId}" ${status !== 'lobby' || r.playerCount >= (r.maxPlayers ?? MAX_PLAYERS) ? 'disabled' : ''}>参加する</button>
            <button class="btn ghost full" data-public-reset="${roomId}">初期化</button>
          </div>
        </div>`;
      }).join('');
      document.querySelectorAll('[data-join]').forEach((b) => b.onclick = () => joinRoom(b.dataset.join));
      document.querySelectorAll('[data-public-reset]').forEach((b) => b.onclick = () => resetRoom(b.dataset.publicReset));
    } catch (e) {
      setNet('offline','接続失敗');
      area.innerHTML = `<div class="notice red">${esc(e.message)}<br>サーバーへ接続できません。</div><button id="retryServer" class="btn primary full" style="margin-top:12px">再接続</button>`;
      $('#retryServer')?.addEventListener('click', loadRooms);
    }
  }

  async function resetRoom(roomId) {
    const roomNo = ROOM_IDS.indexOf(roomId) >= 0 ? ROOM_IDS.indexOf(roomId) + 1 : roomId;
    const ok = confirm(`ROOM ${roomNo} を初期化しますか？`);
    if (!ok) return;
    try {
      await api(`/reset-empty?roomId=${encodeURIComponent(roomId)}`, { method:'POST', cache:'no-store' });
      toast(`ROOM ${roomNo} を初期化しました。`);
      await loadRooms();
    } catch (e) { toast(e.message); }
  }

  async function checkRoomJoin(roomId, playerName, token) {
    const url = new URL(`${WORKER_ORIGIN}/join-check`);
    url.searchParams.set('roomId', roomId);
    url.searchParams.set('name', playerName);
    url.searchParams.set('token', token);
    const response = await fetch(url, { cache:'no-store' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'ROOMへ参加できません。');
    return data;
  }

  async function joinRoom(room) {
    const name = String($('#playerName')?.value || '').trim();
    if (!name) return toast('プレイヤー名を入力してください。');
    sessionStorage.setItem(NAME_DRAFT_KEY, name);
    const token = getToken(room);
    try {
      await checkRoomJoin(room, name, token);
      stopRoomRefresh();
      const data = await api(`/api/room/${room}/join`, { method:'POST', body:JSON.stringify({name, token}) });
      session = { room, playerId:data.playerId, token:data.token || token, name, serverUrl:WORKER_ORIGIN };
      saveSession(); state = data.state; renderGame(); connectRealtime();
    } catch (e) { toast(e.message); renderTitle(); }
  }

  async function reconnect() {
    if (!session?.room || !session?.token) return renderTitle();
    serverUrl = normalizeServer(WORKER_ORIGIN);
    try {
      const data = await api(`/api/room/${session.room}/join`, {
        method:'POST', body:JSON.stringify({ playerId:session.playerId || '', token:session.token, name:session.name || '' })
      });
      session.playerId = data.playerId;
      session.token = data.token || session.token;
      session.name = data.state?.players?.find((p) => p.id === data.playerId)?.name || session.name;
      session.serverUrl = WORKER_ORIGIN;
      saveSession();
      state = data.state; renderGame(); connectRealtime();
    } catch {
      clearSession(); renderTitle();
    }
  }

  function restoreSession() {
    if (session?.room && session?.token) {
      if (ROOM_IDS.includes(session.room)) {
        if (!storedToken(session.room)) localStorage.setItem(tokenKey(session.room), session.token);
        return reconnect();
      }
      session = null;
    }
    const room = localStorage.getItem(ACTIVE_ROOM_KEY);
    const name = localStorage.getItem(ACTIVE_NAME_KEY);
    const token = room && ROOM_IDS.includes(room) ? storedToken(room) : '';
    if (room && name && token) {
      session = { room, token, name, serverUrl:WORKER_ORIGIN };
      return reconnect();
    }
    renderTitle();
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
    captureAnswerDraft();
    if (state.phase !== 'guess' || !state.isGuesser) answerDraft = '';
    onRoomStateReceived(state);
    stopRoomRefresh();
    const top = $('#roomTopControls');
    if (top) top.innerHTML = `${state.canReset?'<button id="topResetRoom" class="topbarBtn">初期化</button>':''}<button id="topLeaveRoom" class="topbarBtn danger">退出</button>`;

    const header = `${statusHtml()}<section class="turnHead">${roleHtml()}<div class="bigName">${esc(me()?.name || '')}</div><div class="muted">${roomLabel(session.room)} / ${esc(modeName(state.mode))}</div></section>`;
    let body = '';

    if (state.phase === 'lobby') {
      body = `${lobbyModeHtml()}<section class="panel actions lobbyActions">
        ${state.isHost?`<button id="addCpu" class="btn secondary full" ${state.players.length>=MAX_PLAYERS?'disabled':''}>テストCPUを追加</button><button id="startGame" class="btn primary full" ${state.canStart?'':'disabled'}>ゲーム開始</button>`:'<div class="notice">ホストがゲームを開始するまでお待ちください。</div>'}
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
        body = `<section class="panel stack guessPanel"><div class="notice blue">残ったヒントだけが公開されています。</div>${clueCardsHtml('guess')}<input id="answerInput" class="input answerBig" maxlength="30" placeholder="回答" value="${esc(answerDraft)}"><div class="actions two"><button id="submitAnswer" class="btn primary">回答する</button><button id="pass" class="btn ghost">パス</button></div></section>`;
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
      const reviseButton = state.canReviseResult && state.result !== 'pass'
        ? `<button id="reviseResult" class="btn revise full" data-result="${state.result === 'correct' ? 'wrong' : 'correct'}">${state.result === 'correct' ? '不正解に修正' : '正解に修正'}</button>`
        : '';
      body = `<section class="panel resultPanel"><div class="resultSummary center"><div class="resultMark">${mark}</div><h2>${resultText}</h2><div class="muted">お題</div><div class="answerBig">${esc(state.currentTarget || '')}</div>${state.answer?`<div class="muted resultAnswer">回答：${esc(state.answer)}</div>`:''}${reviseButton?`<div class="resultCorrection"><div class="muted">押し間違えた場合</div>${reviseButton}</div>`:''}</div><div class="resultClues"><div class="resultCluesTitle">削除前の全ヒント</div>${clueCardsHtml('result')}</div></section>
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
    screen.innerHTML = `<div class="gameShell"><div class="gameHeader">${header}</div><div class="phaseArea">${body}</div><aside class="gameSide"><section class="panel playersPanel"><div class="playersHead"><h2 class="sectionTitle">プレイヤー</h2><span class="roomCount">${state.players.length}/${MAX_PLAYERS}</span></div>${playersHtml()}</section></aside></div>`;
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
    on('#submitAnswer', () => { const v = $('#answerInput').value.trim(); if (!v) return toast('回答を入力してください。'); answerDraft = v; action('submitAnswer',{answer:v}); });
    on('#pass', () => { answerDraft = ''; action('pass'); });
    on('#judgeCorrect', () => action('judgeAnswer',{result:'correct'}));
    on('#judgeWrong', () => action('judgeAnswer',{result:'wrong'}));
    on('#reviseResult', () => {
      const b = $('#reviseResult');
      if (!b) return;
      const next = b.dataset.result;
      const label = next === 'correct' ? '正解' : '不正解';
      if (confirm(`このラウンドの判定を「${label}」に修正しますか？`)) action('reviseResult',{result:next});
    });
    on('#nextRound', () => action('nextRound'));
    on('#restartSame', () => action('restartSame'));
    on('#backLobby', () => action('backToLobby'));
    on('#topLeaveRoom', () => { if (confirm(state.phase === 'lobby' ? '部屋から退出しますか？' : 'マッチから退出しますか？')) action('leave'); });
    on('#topResetRoom', () => {
      if (confirm('この部屋を完全に初期化しますか？参加者も全員退出扱いになります。')) action('reset',{keepPlayers:false});
    });
    const clue = $('#clueInput'); if (clue) clue.addEventListener('keydown',(e)=>{if(e.key==='Enter') $('#submitClue')?.click();});
    const ans = $('#answerInput'); if (ans) {
      ans.addEventListener('input', () => { answerDraft = ans.value; });
      ans.addEventListener('keydown',(e)=>{if(e.key==='Enter') $('#submitAnswer')?.click();});
    }
  }


  $('#topicListButton')?.addEventListener('click', openTopicModal);
  $('#topicClose')?.addEventListener('click', closeTopicModal);
  $('#topicModal')?.addEventListener('click', (event) => {
    if (event.target === $('#topicModal')) closeTopicModal();
  });
  $('#topicSearch')?.addEventListener('input', renderTopicList);
  $('#topicAddButton')?.addEventListener('click', () => {
    const value = String($('#topicAddInput')?.value || '').trim();
    if (!value) return toast('追加するお題を入力してください。');
    updateTopicList('add', value);
  });
  $('#topicAddInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('#topicAddButton')?.click();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeTopicModal();
  });


  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session && (!socket || socket.readyState !== WebSocket.OPEN)) {
      scheduleReconnect();
    }
  });

  window.addEventListener('online', () => {
    if (session && (!socket || socket.readyState !== WebSocket.OPEN)) {
      scheduleReconnect();
    }
  });

  restoreSession();
})();

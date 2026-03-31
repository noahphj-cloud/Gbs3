// 온라인 플레이 기능을 제공하는 클라이언트 스크립트
// 모드 선택, 매칭 대기, SSE 이벤트 수신, 채팅, 턴 제어를 담당한다.

(function() {
  const SUPPORTED_GAMES = ['axis4', 'gomoku', 'quoridor', 'dab'];

  const gameConfigs = {
    axis4: { pageId: 'pageAxis4', init: 'axis4Init', apply: 'axis4ApplyMove', onMoveCallbackName: 'axis4OnMove' },
    gomoku: { pageId: 'pageGomoku', init: 'gomokuInit', apply: 'gomokuApplyMove', onMoveCallbackName: 'gomokuOnMove' },
    quoridor: { pageId: 'pageQuoridor', init: 'quoridorInit', apply: 'quoridorApplyMove', onMoveCallbackName: 'quoridorOnMove' },
    dab: { pageId: 'pageDAB', init: 'dabInit', apply: 'dabApplyMove', onMoveCallbackName: 'dabOnMove' },
    airhockey: { pageId: 'pageAirHockey', init: 'airInit' }
  };

  let currentGame = null;
  let gameMode = null;
  let playerId = null;
  let roomId = null;
  let playerIndex = null;
  let eventSource = null;
  let myTurnFlag = false;
  let onlineGameStarted = false;
  let onlineUiLocked = false;

  function openModeSelect(game) {
    currentGame = game;
    const overlay = document.getElementById('modeSelect');
    overlay.classList.add('show');
    const onlineBtn = document.getElementById('onlinePlayButton');
    if (SUPPORTED_GAMES.includes(game)) {
      onlineBtn.disabled = false;
      onlineBtn.textContent = '온라인 플레이';
    } else {
      onlineBtn.disabled = true;
      onlineBtn.textContent = '온라인 미지원';
    }
  }
  window.openModeSelect = openModeSelect;

  function closeModeSelect() {
    const overlay = document.getElementById('modeSelect');
    if (overlay) overlay.classList.remove('show');
  }

  const originalShowPage = window.showPage;
  if (typeof originalShowPage === 'function') {
    window.showPage = function(id) {
      if (id === 'pageMenu' && gameMode === 'online') {
        teardownOnlineSession(true);
      }
      return originalShowPage(id);
    };
  }

  function setButtonsDisabled(selectorList, disabled) {
    selectorList.forEach((selector) => {
      document.querySelectorAll(selector).forEach((el) => {
        el.disabled = !!disabled;
      });
    });
  }

  function lockOnlineUnsafeButtons() {
    onlineUiLocked = true;
    setButtonsDisabled([
      '.restart-btn',
      'button[onclick*="Undo"]',
      'button[onclick*="Restart"]',
      'button[onclick*="Init()"]',
      'button[onclick*="Init("]'
    ], true);
  }

  function unlockOnlineUnsafeButtons() {
    onlineUiLocked = false;
    setButtonsDisabled([
      '.restart-btn',
      'button[onclick*="Undo"]',
      'button[onclick*="Restart"]',
      'button[onclick*="Init()"]',
      'button[onclick*="Init("]'
    ], false);
  }

  function bestEffortLeave() {
    if (!playerId) return;
    const body = JSON.stringify({ playerId });
    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon('/leave', blob);
      } else {
        fetch('/leave', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          keepalive: true
        }).catch(() => {});
      }
    } catch (_) {}
  }

  function teardownOnlineSession(notifyServer) {
    if (notifyServer === true) bestEffortLeave();
    onlineGameStarted = false;
    myTurnFlag = false;
    roomId = null;
    playerIndex = null;
    if (eventSource) {
      try { eventSource.close(); } catch (_) {}
      eventSource = null;
    }
    if (currentGame && gameConfigs[currentGame] && gameConfigs[currentGame].onMoveCallbackName) {
      window[gameConfigs[currentGame].onMoveCallbackName] = null;
    }
    unlockOnlineUnsafeButtons();
    hideWaiting();
    removeChatUI();
  }

  function startOffline() {
    gameMode = 'offline';
    closeModeSelect();
    teardownOnlineSession(true);
    const cfg = gameConfigs[currentGame];
    if (!cfg) return;
    showPage(cfg.pageId);
    if (typeof window[cfg.init] === 'function') window[cfg.init]();
    hideWaiting();
    removeChatUI();
  }
  window.startOffline = startOffline;

  function startOnline() {
    gameMode = 'online';
    closeModeSelect();
    joinOnlineGame(currentGame);
  }
  window.startOnline = startOnline;

  function joinOnlineGame(gameType) {
    teardownOnlineSession(true);
    showWaiting();
    removeChatUI();

    fetch('/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameType })
    })
      .then(res => res.json())
      .then(data => {
        if (!data || !data.playerId) throw new Error(data && data.error ? data.error : 'join failed');
        currentGame = gameType;
        playerId = data.playerId;
        roomId = data.roomId || null;
        playerIndex = data.playerIndex == null ? null : data.playerIndex;
        setupEventSource();
      })
      .catch(err => {
        console.error(err);
        hideWaiting();
        alert('매칭 중 오류가 발생했습니다.');
      });
  }

  function setupEventSource() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource(`/events?playerId=${encodeURIComponent(playerId)}`);

    eventSource.addEventListener('start', function(event) {
      try {
        const data = JSON.parse(event.data);
        roomId = data.roomId;
        playerIndex = data.playerIndex;
        currentGame = data.gameType || currentGame;
        beginGame();
      } catch (e) {
        console.error(e);
      }
    });

    eventSource.addEventListener('move', function(event) {
      try {
        const data = JSON.parse(event.data);
        handleRemoteMove(data);
      } catch (e) {
        console.error(e);
      }
    });

    eventSource.addEventListener('chat', function(event) {
      try {
        const data = JSON.parse(event.data);
        appendChatMessage(data);
      } catch (e) {
        console.error(e);
      }
    });

    eventSource.addEventListener('end', function(event) {
      let payload = { message: '상대가 연결을 종료했어.' };
      try { payload = JSON.parse(event.data); } catch (_) {}
      appendSystemMessage(payload.message || '게임이 종료되었어.');
      myTurnFlag = false;
      updateTurnControl();
      onlineGameStarted = false;
      unlockOnlineUnsafeButtons();
      if (eventSource) {
        try { eventSource.close(); } catch (_) {}
        eventSource = null;
      }
    });

    eventSource.onerror = function(err) {
      console.error('SSE error', err);
    };
  }

  function normalizeOutgoingMove(args) {
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      return args[0];
    }
    return args;
  }

  function beginGame() {
    if (onlineGameStarted) return;
    onlineGameStarted = true;
    hideWaiting();

    const cfg = gameConfigs[currentGame];
    if (!cfg) return;
    showPage(cfg.pageId);
    if (typeof window[cfg.init] === 'function') window[cfg.init]();
    lockOnlineUnsafeButtons();

    if (cfg.onMoveCallbackName) {
      window[cfg.onMoveCallbackName] = function() {
        if (!myTurnFlag) return;
        const payload = normalizeOutgoingMove(Array.from(arguments));
        sendMove(currentGame, payload);

        if (detectGameOverUi() || (payload && typeof payload === 'object' && !Array.isArray(payload) && payload.gameOver === true)) {
          myTurnFlag = false;
        } else if (currentGame === 'dab' && payload && typeof payload === 'object' && !Array.isArray(payload) && payload.keepTurn === true) {
          myTurnFlag = true;
        } else {
          myTurnFlag = false;
        }
        updateTurnControl();
      };
    }

    myTurnFlag = playerIndex === 0;
    updateTurnControl();
    setupChatUI();
    appendSystemMessage(playerIndex === 0 ? '매칭 완료! 네가 선공이야.' : '매칭 완료! 상대가 먼저 둬.');
  }

  function sendMove(kind, movePayload) {
    fetch('/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId, move: { kind, payload: movePayload } })
    }).catch(err => console.error(err));
  }

  function detectGameOverUi() {
    const overlayMap = {
      axis4: 'axis4Overlay',
      gomoku: 'gOverlay',
      quoridor: 'quorOverlay',
      dab: 'dabOverlay'
    };
    const id = overlayMap[currentGame];
    if (!id) return false;
    const el = document.getElementById(id);
    return !!(el && el.classList.contains('show'));
  }

  function handleRemoteMove(eventData) {
    if (!eventData || !eventData.move) return;
    if (eventData.playerIndex === playerIndex) return;

    const cfg = gameConfigs[currentGame];
    if (!cfg) return;

    const move = eventData.move;
    const kind = move.kind || currentGame;
    const payload = Object.prototype.hasOwnProperty.call(move, 'payload') ? move.payload : move.data;
    let appliedMeta = { applied: false, gameOver: false, keepTurn: false };

    try {
      if ((kind === 'axis4' || currentGame === 'axis4') && Array.isArray(payload)) {
        const [r, c, player] = payload;
        if (typeof window[cfg.apply] === 'function') appliedMeta = window[cfg.apply](r, c, player) || appliedMeta;
      } else if ((kind === 'gomoku' || currentGame === 'gomoku') && Array.isArray(payload)) {
        const [r, c, player] = payload;
        if (typeof window[cfg.apply] === 'function') appliedMeta = window[cfg.apply](r, c, player) || appliedMeta;
      } else if ((kind === 'dab' || currentGame === 'dab')) {
        if (Array.isArray(payload)) {
          const [type, r, c, player] = payload;
          if (typeof window[cfg.apply] === 'function') appliedMeta = window[cfg.apply](type, r, c, player) || appliedMeta;
        } else if (payload && typeof payload === 'object') {
          if (typeof window[cfg.apply] === 'function') appliedMeta = window[cfg.apply](payload.type, payload.r, payload.c, payload.player) || appliedMeta;
        }
      } else if ((kind === 'quoridor' || currentGame === 'quoridor') && payload && typeof payload === 'object') {
        if (typeof window[cfg.apply] === 'function') appliedMeta = window[cfg.apply](payload) || { applied: true, gameOver: false, keepTurn: false };
      }
    } catch (e) {
      console.error(e);
      appliedMeta = { applied: false, gameOver: false, keepTurn: false };
    }

    if (!appliedMeta || appliedMeta.applied === false) {
      return;
    }
    if (detectGameOverUi() || appliedMeta.gameOver === true) {
      myTurnFlag = false;
    } else if (currentGame === 'dab' && appliedMeta.keepTurn === true) {
      myTurnFlag = false;
    } else {
      myTurnFlag = true;
    }
    updateTurnControl();
  }

  function setCanvasInteractivity(canvasId, enabled) {
    const canvas = document.getElementById(canvasId);
    if (canvas) canvas.style.pointerEvents = enabled ? 'auto' : 'none';
  }

  function updateTurnControl() {
    if (gameMode !== 'online') return;
    if (currentGame === 'axis4') {
      const btn = document.getElementById('axis4CommitBtn');
      if (btn && !myTurnFlag) btn.disabled = true;
      setCanvasInteractivity('axis4Canvas', myTurnFlag);
    }
    if (currentGame === 'gomoku') {
      const btn = document.getElementById('gomokuCommitBtn');
      if (btn && !myTurnFlag) btn.disabled = true;
      setCanvasInteractivity('gomokuCanvas', myTurnFlag);
    }
    if (currentGame === 'quoridor') {
      ['quorMoveBtn', 'quorWallBtn', 'quorInstallBtn', 'quorClearBtn'].forEach((id) => {
        const el = document.getElementById(id);
        if (el && !myTurnFlag) el.disabled = true;
      });
      setCanvasInteractivity('quoridorCanvas', myTurnFlag);
      if (myTurnFlag && typeof window.quoridorSetMode === 'function') {
        try {
          // let in-page logic recompute button states
          window.quoridorSetMode(document.getElementById('quorWallBtn') && document.getElementById('quorWallBtn').classList.contains('active-mode') ? 'wall' : 'move');
        } catch (_) {}
      }
    }
    if (currentGame === 'dab') {
      setCanvasInteractivity('dabCanvas', myTurnFlag);
    }
  }

  function showWaiting() {
    let overlay = document.getElementById('waitingOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'waitingOverlay';
      overlay.className = 'overlay';
      overlay.innerHTML = '<div class="overlay-box"><h2>매칭 대기 중...</h2><p>다른 플레이어를 기다리는 중입니다.</p></div>';
      document.body.appendChild(overlay);
    }
    overlay.classList.add('show');
  }

  function hideWaiting() {
    const overlay = document.getElementById('waitingOverlay');
    if (overlay) overlay.classList.remove('show');
  }

  function setupChatUI() {
    const cfg = gameConfigs[currentGame];
    if (!cfg) return;
    const pageEl = document.getElementById(cfg.pageId);
    if (!pageEl) return;

    removeChatUI();

    const chat = document.createElement('div');
    chat.id = 'chatContainer';
    chat.className = 'chat-container';
    chat.innerHTML =
      '<div id="chatMessages" class="chat-messages"></div>' +
      '<div class="chat-input">' +
      '<input id="chatInput" type="text" placeholder="메시지 입력..." />' +
      '<button id="chatSendBtn">보내기</button>' +
      '</div>';
    pageEl.appendChild(chat);

    const sendBtn = chat.querySelector('#chatSendBtn');
    const input = chat.querySelector('#chatInput');
    sendBtn.addEventListener('click', function() {
      const text = input.value.trim();
      if (!text) return;
      fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId, message: text })
      }).catch(console.error);
      input.value = '';
    });
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') sendBtn.click();
    });
  }

  function appendChatMessage(msg) {
    const list = document.getElementById('chatMessages');
    if (!list) return;
    const p = document.createElement('p');
    const prefix = msg.playerIndex === playerIndex ? '나: ' : '상대: ';
    p.textContent = prefix + msg.message;
    list.appendChild(p);
    list.scrollTop = list.scrollHeight;
  }

  function appendSystemMessage(text) {
    const list = document.getElementById('chatMessages');
    if (!list) return;
    const p = document.createElement('p');
    p.style.opacity = '0.7';
    p.textContent = `[시스템] ${text}`;
    list.appendChild(p);
    list.scrollTop = list.scrollHeight;
  }

  function removeChatUI() {
    const chat = document.getElementById('chatContainer');
    if (chat) chat.remove();
  }

  window.addEventListener('beforeunload', function() {
    bestEffortLeave();
  });
})();

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const WRITTEN_FOLDER_NAME = '執筆済み';
const DRAFT_PREFIX = 'plotdraft:';
const NEW_DRAFT_KEY = '__new__';
const TOKEN_REFRESH_MS = 45 * 60 * 1000; // 45分経過したら保存前にトークンを更新

let accessToken = null;
let tokenClient = null;
let tokenObtainedAt = 0;
let tokenResolve = null; // requestAccessToken を Promise 化するための resolver
let tokenRefreshTimer = null; // 失効前サイレント更新のタイマー
let currentFile = null; // { id, name } または null（新規）
let allFiles = []; // { id, name, modifiedTime, snippet }
let currentFolder = 'active'; // 'active' | 'written'
let writtenFolderId = null;
let reorderMode = false;
let orderedFiles = []; // 並べ替えモード中の表示順
let dragSrcIndex = null;
let autoScrollRAF = null;
let lastDragClientY = 0;
let draftTimer = null;

const el = (id) => document.getElementById(id);
const statusEl = () => el('status');

function setStatus(msg) {
  statusEl().textContent = msg || '';
}

function showApp(show) {
  el('app').classList.toggle('hidden', !show);
  el('signin-btn').classList.toggle('hidden', show);
  el('signout-btn').classList.toggle('hidden', !show);
}

function showListView() {
  el('list-view').classList.remove('hidden');
  el('editor-view').classList.add('hidden');
  currentFile = null;
}

function showEditorView() {
  el('list-view').classList.add('hidden');
  el('editor-view').classList.remove('hidden');
}

function stripExt(name) {
  return name.endsWith('.txt') ? name.slice(0, -4) : name;
}

function isEditorOpen() {
  return !el('editor-view').classList.contains('hidden');
}

// --- ① ローカル下書き自動保存 ---

function draftKey() {
  return DRAFT_PREFIX + (currentFile && currentFile.id ? currentFile.id : NEW_DRAFT_KEY);
}

function saveDraftNow() {
  if (!isEditorOpen()) return;
  const data = {
    title: el('title-input').value,
    body: el('body-input').value,
    ts: Date.now(),
  };
  try {
    localStorage.setItem(draftKey(), JSON.stringify(data));
  } catch (e) {
    /* localStorage不可でも致命的ではない */
  }
}

function scheduleDraftSave() {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraftNow, 1000);
}

function clearDraft(key) {
  try {
    localStorage.removeItem(key || draftKey());
  } catch (e) {
    /* noop */
  }
}

// 開いた内容とローカル下書きに差分があれば復元を提案する
function maybeRestoreDraft(serverTitle, serverBody) {
  let raw;
  try {
    raw = localStorage.getItem(draftKey());
  } catch (e) {
    return;
  }
  if (!raw) return;
  let d;
  try {
    d = JSON.parse(raw);
  } catch (e) {
    clearDraft();
    return;
  }
  if (d.title === serverTitle && d.body === serverBody) {
    clearDraft(); // 差分なし＝救済不要
    return;
  }
  const when = new Date(d.ts).toLocaleString('ja-JP');
  if (window.confirm(`未保存の下書き（${when}）が見つかりました。復元しますか？\n［キャンセル］でサーバー上の内容を表示します。`)) {
    el('title-input').value = d.title;
    el('body-input').value = d.body;
  } else {
    clearDraft();
  }
}

// --- ③ トークン取得を Promise 化 ---

function ensureToken(interactive) {
  return new Promise((resolve) => {
    let settled = false;
    // callback / error_callback / タイムアウトのいずれか一度だけ解決する
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      if (tokenResolve === finish) tokenResolve = null;
      resolve(ok);
    };
    // GISが無応答でも固まらないよう保険（10秒）
    const guard = setTimeout(() => finish(false), 10000);
    tokenResolve = finish;
    try {
      tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
    } catch (e) {
      finish(false);
    }
  });
}

// 失効の2分前にサイレント更新を予約する（放置中もトークンを延命）
function scheduleTokenRefresh(expiresInSec) {
  if (tokenRefreshTimer) clearTimeout(tokenRefreshTimer);
  const lead = 120; // 秒
  const delayMs = Math.max((expiresInSec - lead) * 1000, 30000);
  tokenRefreshTimer = setTimeout(async () => {
    if (!accessToken) return;
    await ensureToken(false); // 成功すれば callback 側で次回分が再スケジュールされる
  }, delayMs);
}

async function onSignedIn() {
  showApp(true);
  showListView();
  await listFiles();
}

async function driveFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (res.status === 401) {
    accessToken = null;
    if (isEditorOpen()) {
      saveDraftNow(); // 入力内容を退避してからエラーを投げる（エディタは隠さない）
    } else {
      setStatus('認証の有効期限が切れました。再度サインインしてください。');
      showApp(false);
    }
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive API error (${res.status}): ${text}`);
  }
  return res;
}

async function fetchSnippet(id) {
  try {
    const res = await driveFetch(`${DRIVE_FILES_API}/${id}?alt=media`);
    const text = await res.text();
    return text.replace(/\r?\n/g, ' ').trim().slice(0, 50);
  } catch (e) {
    return '';
  }
}

async function findWrittenFolderId() {
  if (writtenFolderId) return writtenFolderId;
  const q = encodeURIComponent(
    `'${CONFIG.FOLDER_ID}' in parents and trashed=false and mimeType='application/vnd.google-apps.folder' and name='${WRITTEN_FOLDER_NAME}'`
  );
  const fields = encodeURIComponent('files(id,name)');
  const res = await driveFetch(`${DRIVE_FILES_API}?q=${q}&fields=${fields}`);
  const data = await res.json();
  if (data.files && data.files.length > 0) {
    writtenFolderId = data.files[0].id;
  }
  return writtenFolderId;
}

async function ensureWrittenFolderId() {
  const existing = await findWrittenFolderId();
  if (existing) return existing;
  const res = await driveFetch(DRIVE_FILES_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: WRITTEN_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [CONFIG.FOLDER_ID],
    }),
  });
  const data = await res.json();
  writtenFolderId = data.id;
  return writtenFolderId;
}

async function getActiveFolderId() {
  if (currentFolder === 'written') {
    return await findWrittenFolderId();
  }
  return CONFIG.FOLDER_ID;
}

function setFolderTab(kind) {
  if (currentFolder === kind) return;
  currentFolder = kind;
  el('tab-active').classList.toggle('active', kind === 'active');
  el('tab-written').classList.toggle('active', kind === 'written');
  el('new-btn').classList.toggle('hidden', kind !== 'active');
  el('reorder-btn').classList.toggle('hidden', kind !== 'active');
  if (reorderMode) exitReorderMode(false);
  listFiles();
}

async function listFiles() {
  setStatus('読み込み中...');
  const folderId = await getActiveFolderId();
  if (!folderId) {
    allFiles = [];
    sortAndRender();
    setStatus('');
    return;
  }
  const q = encodeURIComponent(
    `'${folderId}' in parents and trashed=false and mimeType='text/plain'`
  );
  const fields = encodeURIComponent('files(id,name,modifiedTime)');
  const url = `${DRIVE_FILES_API}?q=${q}&fields=${fields}&pageSize=200`;
  const res = await driveFetch(url);
  const data = await res.json();
  const files = data.files || [];

  setStatus('本文を読み込み中...');
  const snippets = await Promise.all(files.map((f) => fetchSnippet(f.id)));
  allFiles = files.map((f, i) => ({ ...f, snippet: snippets[i] }));

  sortAndRender();
  setStatus('');
}

function getSortedFiles() {
  const sortValue = el('sort-select').value;
  const sorted = [...allFiles];
  switch (sortValue) {
    case 'name-desc':
      sorted.sort((a, b) => stripExt(b.name).localeCompare(stripExt(a.name), 'ja', { numeric: true }));
      break;
    case 'modified-desc':
      sorted.sort((a, b) => new Date(b.modifiedTime) - new Date(a.modifiedTime));
      break;
    case 'modified-asc':
      sorted.sort((a, b) => new Date(a.modifiedTime) - new Date(b.modifiedTime));
      break;
    case 'name-asc':
    default:
      sorted.sort((a, b) => stripExt(a.name).localeCompare(stripExt(b.name), 'ja', { numeric: true }));
      break;
  }
  return sorted;
}

function sortAndRender() {
  if (reorderMode) {
    renderFileList(orderedFiles);
    return;
  }
  renderFileList(getSortedFiles());
}

function enterReorderMode() {
  if (currentFolder !== 'active') return;
  reorderMode = true;
  orderedFiles = getSortedFiles();
  el('sort-select').disabled = true;
  el('reorder-btn').textContent = '並べ替え終了';
  el('renumber-btn').classList.remove('hidden');
  renderFileList(orderedFiles);
}

function exitReorderMode(reRender = true) {
  reorderMode = false;
  dragSrcIndex = null;
  stopAutoScroll();
  el('sort-select').disabled = false;
  el('reorder-btn').textContent = '並べ替えモード';
  el('renumber-btn').classList.add('hidden');
  if (reRender) sortAndRender();
}

function toggleReorderMode() {
  if (reorderMode) exitReorderMode();
  else enterReorderMode();
}

function startAutoScroll() {
  const EDGE = 90;
  const MAX_SPEED = 18;
  const step = () => {
    const y = lastDragClientY;
    const h = window.innerHeight;
    if (y < EDGE) {
      window.scrollBy(0, -MAX_SPEED * (1 - y / EDGE));
    } else if (y > h - EDGE) {
      window.scrollBy(0, MAX_SPEED * (1 - (h - y) / EDGE));
    }
    autoScrollRAF = requestAnimationFrame(step);
  };
  if (!autoScrollRAF) autoScrollRAF = requestAnimationFrame(step);
}

function stopAutoScroll() {
  if (autoScrollRAF) cancelAnimationFrame(autoScrollRAF);
  autoScrollRAF = null;
}

function renderFileList(files) {
  const listEl = el('file-list');
  listEl.innerHTML = '';
  if (files.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'ファイルがありません';
    listEl.appendChild(li);
    return;
  }
  for (const f of files) {
    const li = document.createElement('li');
    li.draggable = reorderMode;

    if (reorderMode) {
      const handle = document.createElement('span');
      handle.className = 'drag-handle';
      handle.textContent = '⠿';
      li.appendChild(handle);

      li.addEventListener('dragstart', (e) => {
        dragSrcIndex = orderedFiles.findIndex((x) => x.id === f.id);
        e.dataTransfer.effectAllowed = 'move';
        li.classList.add('dragging');
        lastDragClientY = e.clientY;
        startAutoScroll();
      });
      li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        dragSrcIndex = null;
        stopAutoScroll();
      });
      li.addEventListener('dragover', (e) => {
        e.preventDefault();
        const targetIndex = orderedFiles.findIndex((x) => x.id === f.id);
        if (dragSrcIndex === null || targetIndex === dragSrcIndex) return;
        const [moved] = orderedFiles.splice(dragSrcIndex, 1);
        orderedFiles.splice(targetIndex, 0, moved);
        dragSrcIndex = targetIndex;
        renderFileList(orderedFiles);
      });
      li.addEventListener('drop', (e) => e.preventDefault());
    }

    const mainEl = document.createElement('div');
    mainEl.className = 'file-main';

    const titleEl = document.createElement('div');
    titleEl.className = 'file-title';
    titleEl.textContent = stripExt(f.name);
    mainEl.appendChild(titleEl);

    const snippetEl = document.createElement('div');
    snippetEl.className = 'file-snippet';
    snippetEl.textContent = f.snippet || '';
    mainEl.appendChild(snippetEl);

    if (!reorderMode) {
      mainEl.addEventListener('click', () => openFile(f.id, f.name));
    }
    li.appendChild(mainEl);

    if (currentFolder === 'active' && !reorderMode) {
      const archiveBtn = document.createElement('button');
      archiveBtn.className = 'archive-btn';
      archiveBtn.textContent = '執筆済みへ';
      archiveBtn.title = '執筆済みフォルダへ移動';
      archiveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        archiveFileWithConfirm(f.id, f.name);
      });
      li.appendChild(archiveBtn);
    }

    listEl.appendChild(li);
  }
}

async function openFile(id, name) {
  setStatus('読み込み中...');
  const res = await driveFetch(`${DRIVE_FILES_API}/${id}?alt=media`);
  const text = await res.text();
  currentFile = { id, name };
  const title = stripExt(name);
  el('title-input').value = title;
  el('body-input').value = text;
  el('archive-btn').classList.toggle('hidden', currentFolder !== 'active');
  showEditorView();
  maybeRestoreDraft(title, text);
  setStatus('');
}

function newFile() {
  currentFile = null;
  el('title-input').value = '';
  el('body-input').value = '';
  el('archive-btn').classList.add('hidden');
  showEditorView();
  maybeRestoreDraft('', '');
}

function buildMultipartBody(metadata, content) {
  const boundary = 'plot_text_editor_boundary';
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: text/plain; charset=UTF-8\r\n\r\n' +
    `${content}\r\n` +
    `--${boundary}--`;
  return { body, boundary };
}

async function doSave(name, content) {
  if (currentFile && currentFile.id) {
    const metadata = { name };
    const { body, boundary } = buildMultipartBody(metadata, content);
    await driveFetch(`${DRIVE_UPLOAD_API}/${currentFile.id}?uploadType=multipart`, {
      method: 'PATCH',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  } else {
    const metadata = { name, parents: [CONFIG.FOLDER_ID], mimeType: 'text/plain' };
    const { body, boundary } = buildMultipartBody(metadata, content);
    await driveFetch(`${DRIVE_UPLOAD_API}?uploadType=multipart`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
  }
}

async function saveFile() {
  const title = el('title-input').value.trim();
  const content = el('body-input').value;
  if (!title) {
    setStatus('タイトルを入力してください');
    return;
  }
  saveDraftNow(); // 保存試行の前に必ず退避
  const name = title.endsWith('.txt') ? title : `${title}.txt`;

  // ③ 長時間経過していれば先にトークンをサイレント更新
  if (accessToken && Date.now() - tokenObtainedAt > TOKEN_REFRESH_MS) {
    setStatus('セッションを更新中...');
    await ensureToken(false);
  }

  setStatus('保存中...');
  try {
    await doSave(name, content);
  } catch (e) {
    if (e.message !== 'unauthorized') {
      setStatus('保存に失敗しました。入力内容は下書きに保存済みです。');
      return;
    }
    // ② セッション切れ時のリカバリ（エディタは維持したまま再認証→再保存）
    setStatus('セッションが切れました。再認証しています...');
    let ok = await ensureToken(false);
    if (!ok) ok = await ensureToken(true);
    if (!ok) {
      setStatus('再認証できませんでした。入力内容は下書きに保存済みです。サインインし直してから、もう一度［保存］を押してください。');
      return;
    }
    try {
      setStatus('保存中...');
      await doSave(name, content);
    } catch (e2) {
      setStatus('保存に失敗しました。入力内容は下書きに保存済みです。');
      return;
    }
  }

  clearDraft(); // 保存成功したので下書きを破棄
  setStatus('保存しました');
  showListView();
  await listFiles();
}

async function renameFile(id, newName) {
  await driveFetch(`${DRIVE_FILES_API}/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: newName }),
  });
}

async function renumberFiles() {
  if (orderedFiles.length === 0) return;
  if (!window.confirm('表示中の順序でファイル名の番号を振り直します。よろしいですか？')) return;
  setStatus('採番中...');
  await Promise.all(
    orderedFiles.map((f, i) => {
      const num = String(i + 1).padStart(3, '0');
      const baseTitle = stripExt(f.name).replace(/^\d+_/, '');
      const newName = `${num}_${baseTitle}.txt`;
      return newName !== f.name ? renameFile(f.id, newName) : Promise.resolve();
    })
  );
  setStatus('番号を振り直しました');
  exitReorderMode(false);
  await listFiles();
}

async function archiveFile(id) {
  setStatus('移動中...');
  const folderId = await ensureWrittenFolderId();
  await driveFetch(
    `${DRIVE_FILES_API}/${id}?addParents=${folderId}&removeParents=${CONFIG.FOLDER_ID}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }
  );
  setStatus('執筆済みフォルダへ移動しました');
}

async function archiveFileWithConfirm(id, name) {
  if (!window.confirm(`「${stripExt(name)}」を執筆済みフォルダへ移動しますか？`)) return;
  await archiveFile(id);
  if (reorderMode) exitReorderMode(false);
  await listFiles();
}

function initGoogle() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: (resp) => {
      const resolve = tokenResolve;
      tokenResolve = null;
      if (resp.error) {
        if (resolve) resolve(false);
        else setStatus(`サインインエラー: ${resp.error}`);
        return;
      }
      accessToken = resp.access_token;
      tokenObtainedAt = Date.now();
      scheduleTokenRefresh(Number(resp.expires_in) || 3600);
      if (resolve) resolve(true);
    },
    error_callback: (err) => {
      // prompt:'none' のサイレント更新失敗などはここに来る（callbackは呼ばれない）
      const resolve = tokenResolve;
      tokenResolve = null;
      if (resolve) resolve(false);
      else setStatus(`サインインエラー: ${err && err.type ? err.type : '認証に失敗しました'}`);
    },
  });
}

function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenObtainedAt = 0;
  if (tokenRefreshTimer) {
    clearTimeout(tokenRefreshTimer);
    tokenRefreshTimer = null;
  }
  showApp(false);
}

window.addEventListener('load', () => {
  initGoogle();
  document.addEventListener('dragover', (e) => {
    if (!reorderMode) return;
    e.preventDefault();
    lastDragClientY = e.clientY;
  });
  el('signin-btn').addEventListener('click', async () => {
    const ok = await ensureToken(true);
    if (ok) await onSignedIn();
  });
  el('signout-btn').addEventListener('click', signOut);
  el('title-input').addEventListener('input', scheduleDraftSave);
  el('body-input').addEventListener('input', scheduleDraftSave);
  el('new-btn').addEventListener('click', newFile);
  el('refresh-btn').addEventListener('click', listFiles);
  el('sort-select').addEventListener('change', sortAndRender);
  el('reorder-btn').addEventListener('click', toggleReorderMode);
  el('renumber-btn').addEventListener('click', renumberFiles);
  el('back-btn').addEventListener('click', showListView);
  el('save-btn').addEventListener('click', saveFile);
  el('tab-active').addEventListener('click', () => setFolderTab('active'));
  el('tab-written').addEventListener('click', () => setFolderTab('written'));
  el('archive-btn').addEventListener('click', async () => {
    if (!currentFile) return;
    if (!window.confirm(`「${el('title-input').value}」を執筆済みフォルダへ移動しますか？`)) return;
    await archiveFile(currentFile.id);
    showListView();
    await listFiles();
  });
});

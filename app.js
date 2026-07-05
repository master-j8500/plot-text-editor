const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';
const WRITTEN_FOLDER_NAME = '執筆済み';

let accessToken = null;
let tokenClient = null;
let currentFile = null; // { id, name } または null（新規）
let allFiles = []; // { id, name, modifiedTime, snippet }
let currentFolder = 'active'; // 'active' | 'written'
let writtenFolderId = null;
let reorderMode = false;
let orderedFiles = []; // 並べ替えモード中の表示順
let dragSrcIndex = null;

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

async function driveFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (res.status === 401) {
    setStatus('認証の有効期限が切れました。再度サインインしてください。');
    showApp(false);
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
  el('sort-select').disabled = false;
  el('reorder-btn').textContent = '並べ替えモード';
  el('renumber-btn').classList.add('hidden');
  if (reRender) sortAndRender();
}

function toggleReorderMode() {
  if (reorderMode) exitReorderMode();
  else enterReorderMode();
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
      });
      li.addEventListener('dragend', () => {
        li.classList.remove('dragging');
        dragSrcIndex = null;
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

    mainEl.addEventListener('click', () => openFile(f.id, f.name));
    li.appendChild(mainEl);

    if (currentFolder === 'active') {
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
  el('title-input').value = stripExt(name);
  el('body-input').value = text;
  el('archive-btn').classList.toggle('hidden', currentFolder !== 'active');
  showEditorView();
  setStatus('');
}

function newFile() {
  currentFile = null;
  el('title-input').value = '';
  el('body-input').value = '';
  el('archive-btn').classList.add('hidden');
  showEditorView();
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

async function saveFile() {
  const title = el('title-input').value.trim();
  const content = el('body-input').value;
  if (!title) {
    setStatus('タイトルを入力してください');
    return;
  }
  const name = title.endsWith('.txt') ? title : `${title}.txt`;
  setStatus('保存中...');

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
    callback: async (resp) => {
      if (resp.error) {
        setStatus(`サインインエラー: ${resp.error}`);
        return;
      }
      accessToken = resp.access_token;
      showApp(true);
      showListView();
      await listFiles();
    },
  });
}

function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  showApp(false);
}

window.addEventListener('load', () => {
  initGoogle();
  el('signin-btn').addEventListener('click', () => tokenClient.requestAccessToken());
  el('signout-btn').addEventListener('click', signOut);
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

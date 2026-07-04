const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

let accessToken = null;
let tokenClient = null;
let currentFile = null; // { id, name } または null（新規）

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

async function listFiles() {
  setStatus('読み込み中...');
  const q = encodeURIComponent(
    `'${CONFIG.FOLDER_ID}' in parents and trashed=false and mimeType='text/plain'`
  );
  const fields = encodeURIComponent('files(id,name,modifiedTime)');
  const url = `${DRIVE_FILES_API}?q=${q}&fields=${fields}&orderBy=modifiedTime desc&pageSize=200`;
  const res = await driveFetch(url);
  const data = await res.json();
  renderFileList(data.files || []);
  setStatus('');
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
    li.textContent = stripExt(f.name);
    li.addEventListener('click', () => openFile(f.id, f.name));
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
  showEditorView();
  setStatus('');
}

function newFile() {
  currentFile = null;
  el('title-input').value = '';
  el('body-input').value = '';
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
  el('back-btn').addEventListener('click', showListView);
  el('save-btn').addEventListener('click', saveFile);
});

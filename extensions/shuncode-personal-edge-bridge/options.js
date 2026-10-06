'use strict';
const key = 'shuncodeEdgePairingV1';
const status = document.querySelector('#status');
document.querySelector('#pair').addEventListener('submit', async event => {
  event.preventDefault();
  const endpoint = document.querySelector('#endpoint').value.trim().replace(/\/$/, '');
  const token = document.querySelector('#token').value.trim();
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('只接受明确端口的本机 127.0.0.1 地址。');
    if (token.length < 32 || token.length > 256) throw new Error('配对口令格式不正确。');
    const oldClient = (await chrome.storage.local.get('shuncodeEdgeClientId')).shuncodeEdgeClientId;
    const clientId = oldClient || crypto.randomUUID();
    const response = await fetch(endpoint + '/control/personal-edge/register', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, clientId, shared: false, tab: null }), signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!response.ok || !(await response.json()).ok) throw new Error('验证失败，请核实 Nimora 地址与口令。');
    await chrome.storage.session.remove('shuncodeSharedTabId');
    await chrome.storage.local.set({ shuncodeEdgeClientId: clientId, [key]: { endpoint, token } });
    document.querySelector('#token').value = '';
    status.textContent = '配对成功。现在可在目标网页点击扩展图标共享。';
  } catch (error) { status.textContent = error.message; }
});
document.querySelector('#forget').addEventListener('click', async () => {
  const saved = (await chrome.storage.local.get(key))[key];
  const clientId = (await chrome.storage.local.get('shuncodeEdgeClientId')).shuncodeEdgeClientId;
  await chrome.storage.session.remove('shuncodeSharedTabId');
  await chrome.storage.local.remove(key);
  if (saved) { try { await fetch(saved.endpoint + '/control/personal-edge/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: saved.token, clientId, shared: false, tab: null }), signal: AbortSignal.timeout(5000) }); } catch {} }
  document.querySelector('#token').value = ''; status.textContent = '已解除配对并停止共享。';
});
(async () => { const saved = (await chrome.storage.local.get(key))[key]; if (saved?.endpoint) document.querySelector('#endpoint').value = saved.endpoint; })();

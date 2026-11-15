const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { Script } = require('node:vm');

test('native fixture retains publisher lock, independent stopped timer, viewer presence and idempotent end', async () => {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; listener.close(); await once(listener, 'close');
  const child = spawn(process.execPath, [path.resolve(__dirname, '../native-client/test-page/server.cjs')], {
    windowsHide: true, env: { ...process.env, XGOATCAST_TEST_PORT: String(port),
      XGOATCAST_TEST_AGORA_APP_ID: 'a'.repeat(32), XGOATCAST_TEST_AGORA_CERTIFICATE: 'b'.repeat(32),
      XGOATCAST_TEST_ALLOWED_QUALITIES: '720p30' },
  });
  let logs = ''; child.stdout.on('data', data => { logs += data; }); child.stderr.on('data', data => { logs += data; });
  const base = `http://127.0.0.1:${port}`;
  let abort;
  try {
    let ready = false;
    for (let i = 0; i < 50 && child.exitCode === null; i++) {
      try { ready = (await fetch(base + '/test/session')).ok; if (ready) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, logs);
    const html = await (await fetch(base + '/')).text();
    const inline = html.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(inline); new Script(inline[1]);
    const session = await (await fetch(base + '/test/session')).json();
    const call = async (endpoint, body, query = '') => {
      const response = await fetch(base + '/api/share/' + endpoint + '?t=' + session.token + query,
        body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, value: await response.json() };
    };
    const clientId = '00000000-0000-4000-8000-000000000001', start = { quality: '720p30', clientId };
    assert.equal((await call('preview')).value.appId, 'a'.repeat(32));
    assert.equal((await call('token', undefined, '&role=publisher&uid=1')).value.uid, 1);
    assert.equal((await call('start', start)).value.ok, true);
    assert.equal((await call('stop', { clientId: 'foreign' })).status, 403);
    assert.equal((await call('stop', { clientId })).value.ok, true);
    const stopped = (await call('info')).value;
    assert.equal(stopped.status, 'grace'); assert.equal(stopped.graceReason, 'stopped');
    assert.ok(stopped.stoppedRemainingSec > 0 && stopped.stoppedRemainingSec <= 60);
    assert.equal(stopped.idleRemainingSec, undefined); assert.equal(stopped.publisherClientId, clientId);
    abort = new AbortController();
    const stream = await fetch(base + '/api/share/stream?t=' + session.token + '&vid=viewer', { signal: abort.signal });
    const reader = stream.body.getReader(); await reader.read();
    assert.equal((await call('info')).value.viewerCount, 1);
    assert.equal((await call('heartbeat', { clientId })).value.ok, false);
    assert.equal((await call('start', { ...start, autoResume: true })).value.ok, false);
    assert.equal((await call('start', start)).value.ok, true);
    assert.equal((await call('end', { clientId })).value.ok, true);
    assert.equal((await call('end', { clientId })).value.ok, true);
    assert.equal((await call('start', start)).value.ok, false);
    assert.equal((await call('token', undefined, '&role=publisher&uid=1')).status, 401);
    await reader.cancel();
  } finally {
    abort?.abort();
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  }
});

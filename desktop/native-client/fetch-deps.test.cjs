const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),crypto=require('node:crypto');
const {download}=require('./fetch-deps.cjs');
const bytes=Buffer.from('verified dependency');
const hash=crypto.createHash('sha256').update(bytes).digest('hex');
function files(t,cached=false){
  t.mock.method(fs,'existsSync',()=>cached);
  const write=t.mock.method(fs,'writeFileSync',()=>{});
  t.mock.method(fs,'readFileSync',()=>bytes);
  t.mock.method(global,'setTimeout',callback=>{callback();});
  return write;
}
test('network timeout retries and writes only the complete download',async t=>{
  const write=files(t);let attempts=0;
  t.mock.method(global,'fetch',async()=>{
    if(++attempts===1)throw new TypeError('fetch failed',{cause:{code:'UND_ERR_CONNECT_TIMEOUT'}});
    return {ok:true,arrayBuffer:async()=>bytes};
  });
  await download('https://example.com/dependency','test.zip',hash);
  assert.equal(attempts,2);assert.equal(write.mock.calls.length,1);
  assert.deepEqual(write.mock.calls[0].arguments[1],bytes);
});
test('network failure stops after three attempts without a partial file',async t=>{
  const write=files(t);
  const fetch=t.mock.method(global,'fetch',async()=>{throw new TypeError('fetch failed');});
  await assert.rejects(download('https://example.com/dependency','test.zip',hash),/fetch failed/);
  assert.equal(fetch.mock.calls.length,3);assert.equal(write.mock.calls.length,0);
});
test('HTTP errors do not retry or write a file',async t=>{
  const write=files(t);
  const fetch=t.mock.method(global,'fetch',async()=>({ok:false,status:404}));
  await assert.rejects(download('https://example.com/dependency','test.zip',hash),/Download failed: 404/);
  assert.equal(fetch.mock.calls.length,1);assert.equal(write.mock.calls.length,0);
});
test('cached downloads still require the pinned checksum',async t=>{
  const write=files(t,true);
  const fetch=t.mock.method(global,'fetch',async()=>{throw Error('Unexpected network request');});
  await download('https://example.com/dependency','test.zip',hash);
  await assert.rejects(download('https://example.com/dependency','test.zip','wrong checksum'),/Checksum mismatch/);
  assert.equal(fetch.mock.calls.length,0);assert.equal(write.mock.calls.length,0);
});

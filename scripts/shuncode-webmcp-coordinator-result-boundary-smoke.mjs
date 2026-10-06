import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'tools/webmcp-gateway/package.json'));
const { chromium } = require('playwright-core');
const sourceDir = path.join(root, 'extensions/shuncode-webmcp');
const [site, core, agent] = await Promise.all([
  readFile(path.join(sourceDir, 'webmcp-site-adapters.js'), 'utf8'),
  readFile(path.join(sourceDir, 'webmcp-page-core.js'), 'utf8'),
  readFile(path.join(sourceDir, 'arena-agent-bridge.js'), 'utf8'),
]);
const source = `(config => (${agent.trim()})(config, {
  createCore: ${core.trim()},
  createSiteAdapter: ${site.trim()}
}))`;
let executablePath = '';
for (const candidate of [process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean)) {
  try { await access(candidate); executablePath = candidate; break; } catch {}
}
assert.ok(executablePath, 'Isolated headless Edge is required');
const browser = await chromium.launch({ executablePath, headless: true });
const fixture = `<!doctype html><html><body>
  <main id="messages"></main>
  <form><textarea aria-label="Ask anything"></textarea><button type="submit" aria-label="Send">Send</button></form>
  <script>
    window.__submissions = [];
    window.__resultMode = 'normal';
    let key = 0;
    const messages=document.getElementById('messages');
    window.__appendAssistant = (text) => {
      const item=document.createElement('div');
      item.dataset.virtualListItemKey=String(++key);
      item.dataset.kind='assistant';
      const value=document.createElement('div');value.className='ds-assistant-message-main-content';
      value.innerText=text;item.appendChild(value);messages.appendChild(item);
    };
    document.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      const composer=document.querySelector('textarea'), text=composer.value;
      window.__submissions.push(text);
      if(text.startsWith('[SHUNCODE_TOOL_RESULT]')) {
        if(window.__resultMode==='assistant-remounted') {
          document.querySelector('[data-kind="assistant"]')?.remove();
          window.__appendAssistant('remounted assistant state (no tool block)');
        }else if(window.__resultMode==='all-anchors-lost') {
          messages.replaceChildren();
        }
      }
      const item=document.createElement('div');
      item.dataset.virtualListItemKey=String(++key);
      const value=document.createElement('div');value.className='ds-message user-message';
      value.textContent=text;item.appendChild(value);messages.appendChild(item);
      composer.value='';composer.dispatchEvent(new Event('input',{bubbles:true}));
    });
  </script></body></html>`;
const input=id=>({inputId:id,prompt:'Inspect the exact file',allowedCapabilities:['read_files'],
  externalCapabilities:[{name:'read_files',description:'read',inputSchema:{type:'object',
    properties:{files:{type:'array'}},required:['files']}}],
  extensions:{hostManagedCapabilities:true}});
const call='[SHUNCODE_TOOL]\nid=exact-coordinator-call\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]';
async function newPage(label){
  const context=await browser.newContext();
  const page=await context.newPage();
  await page.route('https://chat.deepseek.com/**',route=>route.fulfill({status:200,contentType:'text/html',body:fixture}));
  await page.goto('https://chat.deepseek.com/a/chat/'+label);
  await page.evaluate(source=>(0,eval)(source)({token:'coordinator-result-smoke',
    listBinding:'unused',invokeBinding:'unused',providerAdmissionTimeoutMs:300}),source);
  const sent=await page.evaluate(input=>window.__shuncodeWebMcp.workerSend(input),input(label));
  assert.equal(sent.state,'running');
  await page.evaluate(call=>window.__appendAssistant(call),call);
  await page.evaluate(label=>window.__shuncodeWebMcp.workerPoll(label),label);
  await page.waitForFunction(()=>window.__shuncodeWebMcp.status().pendingHostCapabilities===1,
    null,{timeout:5000});
  const snapshot=await page.evaluate(label=>window.__shuncodeWebMcp.workerPoll(label),label);
  const event=snapshot.events.find(x=>x.type==='capability_call'&&x.callId==='exact-coordinator-call');
  assert.ok(event?.occurrenceId,'only an exact host-managed call can receive a result');
  return {context,page,event};
}
try{
  const admitted=await newPage('assistant-remounted');
  await admitted.page.evaluate(()=>{window.__resultMode='assistant-remounted';});
  await admitted.page.evaluate(async occurrenceId=>{
    await window.__shuncodeWebMcp.workerResolveCapability({
      inputId:'assistant-remounted',callId:'exact-coordinator-call',name:'read_files',
      text:'EXACT_LOCAL_RESULT',isError:false,extensions:{occurrenceId},
    });
  },admitted.event.occurrenceId);
  const valid=await admitted.page.evaluate(()=>({
    status:window.__shuncodeWebMcp.status(),
    sent:window.__submissions.map(x=>x.startsWith('[SHUNCODE_TOOL_RESULT]')?'result':'initial'),
  }));
  assert.deepEqual(valid.sent,['initial','result'],'a remounted assistant cannot trigger an extra send');
  assert.equal(valid.status.pendingHostCapabilities,0);
  assert.equal(valid.status.lastSubmitDiagnostic.state,'admitted');
  assert.equal(valid.status.lastDeliveryError,'');
  await admitted.context.close();

  const unsafe=await newPage('all-anchors-lost');
  await unsafe.page.evaluate(()=>{window.__resultMode='all-anchors-lost';});
  const failure=await unsafe.page.evaluate(async occurrenceId=>{
    try{
      await window.__shuncodeWebMcp.workerResolveCapability({
        inputId:'all-anchors-lost',callId:'exact-coordinator-call',name:'read_files',
        text:'UNPROVEN_LOCAL_RESULT',isError:false,extensions:{occurrenceId},
      });
      return {failed:false};
    }catch(error){return{failed:true,error:String(error?.message||error)};}
  },unsafe.event.occurrenceId);
  assert.equal(failure.failed,true);
  assert.match(failure.error,/provider-conversation-boundary-unverifiable/);
  const stopped=await unsafe.page.evaluate(async()=>{
    const status=window.__shuncodeWebMcp.status();
    const poll=await window.__shuncodeWebMcp.workerPoll('all-anchors-lost');
    let refused='';
    try{await window.__shuncodeWebMcp.workerSend({
      inputId:'MUST_NOT_SEND',prompt:'Do not dispatch an unapproved next instruction',
    });}catch(error){refused=String(error?.message||error);}
    return{status,poll,refused,sends:window.__submissions.length};
  });
  assert.equal(stopped.poll.state,'error','ambiguous result receipt terminates local turn without claiming success');
  assert.equal(stopped.status.pendingHostCapabilities,1,'unconfirmed host result remains auditable');
  assert.equal(stopped.status.resultDeliveryUncertain?.callId,'exact-coordinator-call');
  assert.match(stopped.refused,/unconfirmed provider admission/);
  assert.equal(stopped.sends,2,'unknown provider receipt must never prompt a replay or next send');
  const stored=await unsafe.page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>
    key.startsWith('shuncode-webmcp-unconfirmed-host-result:')).map(([,value])=>JSON.parse(value)));
  assert.equal(stored.length,1,'receipt identities are persisted for same-tab reload, without tool output');
  assert.equal(stored[0].callId,'exact-coordinator-call');
  assert.equal(JSON.stringify(stored).includes('UNPROVEN_LOCAL_RESULT'),false);
  await unsafe.page.reload({waitUntil:'domcontentloaded'});
  await unsafe.page.evaluate(source=>(0,eval)(source)({
    token:'coordinator-result-smoke',listBinding:'unused',invokeBinding:'unused',providerAdmissionTimeoutMs:300,
  }),source);
  const afterReload=await unsafe.page.evaluate(async()=>{
    let rejected='';
    try{await window.__shuncodeWebMcp.workerSend({
      inputId:'MUST_NOT_SEND_AFTER_RELOAD',prompt:'Do not send after same-tab reload',
    });}catch(error){rejected=String(error?.message||error);}
    return {receipt:window.__shuncodeWebMcp.status().resultDeliveryUncertain,
      rejected,sends:window.__submissions.length};
  });
  assert.equal(afterReload.receipt?.inputId,'all-anchors-lost');
  assert.match(afterReload.rejected,/unconfirmed provider admission/);
  assert.equal(afterReload.sends,0,'same-tab reload cannot erase old ambiguous result or send another prompt');
  await unsafe.context.close();
  const legacyContext=await browser.newContext(), legacyPage=await legacyContext.newPage();
  await legacyPage.route('https://chat.deepseek.com/**',route=>
    route.fulfill({status:200,contentType:'text/html',body:fixture}));
  await legacyPage.goto('https://chat.deepseek.com/a/chat/pre-repair-unknown');
  const preRepair=await legacyPage.evaluate(source=>{
    let stopped=0,error='';
    window.__shuncodeWebMcp={
      status:()=>({workerTurn:{state:'cancelled'},pendingHostCapabilities:0,
        pendingDeliveries:0,lastDeliveryError:'provider-conversation-boundary-missing'}),
      stop:()=>{stopped++;},
    };
    try{(0,eval)(source)({token:'coordinator-result-smoke',listBinding:'unused',invokeBinding:'unused'});}
    catch(e){error=String(e?.message||e);}
    return{stopped,error};
  },source);
  assert.match(preRepair.error,/previous work is unsettled/);
  assert.equal(preRepair.stopped,0,
    'source rebuild cannot erase a prior runtime error just because the page visibly stopped');
  await legacyContext.close();
  console.log('PASS coordinator result: safe surviving user anchor + one gesture; missing anchors quarantine old receipt and block new provider work');
}finally{
  await browser.close();
}

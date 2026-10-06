import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createChatGptWorkerController } = require('../extensions/shuncode-webmcp/chatgpt-worker-controller.js');

async function scenario({ persistent = false, wrongText = false } = {}) {
  const pageId = '11111111-1111-4111-8111-111111111111';
  const url = 'https://chatgpt.com/c/admission-observation-test';
  let composer = '', submitted = '', clicks = 0, postSubmitReads = 0;
  const snapshot = showUser => ({ text: [
    'Page Title: ChatGPT', `URL: ${url}`, 'Snapshot:',
    ...(showUser && submitted ? ['- heading "You said:" [level=4] [ref=user0]', `- generic [ref=u0]: ${JSON.stringify(submitted)}`, '- group "Your message actions"'] : []),
    '- textbox "Message ChatGPT" [active] [ref=composer]:', `  - paragraph: ${JSON.stringify(composer || 'Message ChatGPT')}`,
    '  - generic [ref=toolbar]:', '    - button "Send" [ref=send] [cursor=pointer]',
  ].join('\n') });
  const controller = createChatGptWorkerController({
    resultText: value => value.text, structuredValue: value => value,
    getSiteAdapterSource: () => '',
    ensureExactPageVisible: async () => ({ pageId, url, title: 'ChatGPT', visible: true }),
    invokeBrowserTool: async (name, input) => {
      if (name === 'list_browser_pages') return { text: `- [${pageId}] ChatGPT (${url}) visible` };
      if (name === 'read_page') {
        if (submitted) postSubmitReads++;
        return snapshot(!submitted || (!persistent && postSubmitReads > 1));
      }
      if (name === 'type_in_page') { composer = input.text; return snapshot(false); }
      if (name === 'click_element') {
        assert.equal(input.ref, 'send'); clicks++;
        submitted = composer; composer = '';
        return snapshot(false); // Accessibility still precedes the provider DOM update.
      }
      throw new Error(`Unexpected mutation/tool: ${name}`);
    },
    observeExactComposer: async () => ({ href: url, origin: 'https://chatgpt.com', composerFound: true,
      composerAmbiguous: false, composerText: composer, rawComposerText: composer,
      composerLineTags: composer.split('\n').map(() => 'P'), composerDecorations: [] }),
    observeExactProviderUsers: async () => ({ href: url, origin: 'https://chatgpt.com', providerUserRepresentationVersion: 2, providerUsersAmbiguous: false,
      userTurns: submitted ? [{ identity: 'turn-0', text: wrongText ? 'different request' : submitted,
        lineTags: ['USER_TEXT'], identitySource: 'data-turn-key', identityStable: true, presentationKind: 'provider-user-turn' }] : [] }),
  });
  const [target] = await controller.listResources();
  assert(target, 'test page must be a healthy candidate');
  const session = await controller.connect({ target });
  const send = () => controller.control({ action: 'send', pageId, sessionId: session.sessionId,
    input: { inputId: 'new-test-only-request', prompt: 'one exact bounded request' } });
  if (persistent) {
    await assert.rejects(send, error => error.code === 'CHATGPT_PROVIDER_USER_COUNT_MISMATCH');
    assert.equal(postSubmitReads, 26, 'persistent mismatch remains bounded and unadmitted');
  } else if (wrongText) {
    await assert.rejects(send, /unexpected user text/);
  } else {
    const admitted = await send();
    assert.equal(admitted.state, 'running');
    assert(postSubmitReads >= 2, 'a complete fresh observation must converge before admission');
  }
  assert.equal(clicks, 1, 'read-only convergence must never repeat the submit gesture');
}

await scenario();
await scenario({ persistent: true });
await scenario({ wrongText: true });
console.log('PASS: transient count race converges; persistent mismatch and wrong text reject; exactly one submit in every case.');

(function executeShunCodeWebMcpInternalBrowserOperation(env) {
  const {
    operationId,
    input,
    window,
    document,
    location,
    sessionStorage,
    siteAdapterSource,
    pageCoreSource,
    agentBridgeSource,
  } = env || {};

  const visible = element => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);

  if (operationId === 'chatgptObserveComposer') {
    const chatGptHosts = new Set(['chatgpt.com', 'chat.openai.com']);
    if (!chatGptHosts.has(String(location?.hostname || '').toLowerCase())) {
      throw new Error(`Fixed ChatGPT composer observation rejected non-ChatGPT page: ${String(location?.href || '')}`);
    }
    const candidateSelectors = ['#prompt-textarea', '[contenteditable="true"][role="textbox"]'];
    const candidates = [...new Set(candidateSelectors.flatMap(selector => [...document.querySelectorAll(selector)]))]
      .filter(element => visible(element));
    if (candidates.length === 0) {
      return { href: location.href, origin: location.origin, composerFound: false, composerAmbiguous: false, composerText: '' };
    }
    if (candidates.length !== 1) {
      return { href: location.href, origin: location.origin, composerFound: true, composerAmbiguous: true, composerText: '' };
    }
    const composer = candidates[0];
    const tagName = String(composer.tagName || '').toUpperCase();
    if (tagName === 'TEXTAREA' || tagName === 'INPUT') {
      return {
        href: location.href,
        origin: location.origin,
        composerFound: true,
        composerAmbiguous: false,
        composerText: String(composer.value ?? ''),
      };
    }
    if (composer.isContentEditable !== true) {
      return { href: location.href, origin: location.origin, composerFound: true, composerAmbiguous: true, composerText: '' };
    }
    const blockTags = new Set(['P', 'DIV', 'PRE', 'LI']);
    const interactiveTags = new Set(['BUTTON', 'A', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);
    let ambiguous = false;
    const decorations = [];
    const nodeChildren = node => Array.from(node?.childNodes || []);
    const nodeAttribute = (node, name) => typeof node?.getAttribute === 'function'
      ? String(node.getAttribute(name) ?? '')
      : '';
    const pluginMentionIdentity = node => {
      if (!node || node.nodeType !== 1) return null;
      if (nodeAttribute(node, 'contenteditable').toLowerCase() !== 'false') return null;
      const name = nodeAttribute(node, 'plugin-mention-name').trim();
      const path = nodeAttribute(node, 'plugin-mention-path').trim();
      const href = nodeAttribute(node, 'data-prompt-link-href').trim();
      const label = nodeAttribute(node, 'data-prompt-link-label').trim();
      if (!name || !path || !href || !label) return null;
      if (path !== href || !path.startsWith(`plugin://${name}@`) || label !== `@${name}`) return null;
      return {
        kind: 'plugin-mention',
        tagName: String(node.tagName || '').toUpperCase(),
        name,
        path,
        href,
        label,
      };
    };
    const appMentionIdentity = node => {
      if (!node || node.nodeType !== 1) return null;
      if (nodeAttribute(node, 'contenteditable').toLowerCase() !== 'false') return null;
      const name = nodeAttribute(node, 'app-mention-name').trim();
      const displayName = nodeAttribute(node, 'app-mention-display-name').trim();
      const path = nodeAttribute(node, 'app-mention-path').trim();
      const href = nodeAttribute(node, 'data-prompt-link-href').trim();
      const label = nodeAttribute(node, 'data-prompt-link-label').trim();
      const visibleText = String(node.textContent ?? '').trim();
      if (!name || !displayName || !path || !href || !label) return null;
      if (visibleText !== displayName || path !== href || !/^app:\/\/asdk_app_[A-Za-z0-9_-]+$/.test(path) || label !== `$${name}`) return null;
      return {
        kind: 'app-mention',
        tagName: String(node.tagName || '').toUpperCase(),
        name,
        path,
        href,
        label,
      };
    };
    const mentionIdentity = node => pluginMentionIdentity(node) || appMentionIdentity(node);
    const isMention = node => !!mentionIdentity(node);
    const nodeText = node => {
      if (!node) return '';
      if (node.nodeType === 3) return String(node.data ?? node.nodeValue ?? '');
      if (node.nodeType !== 1) return '';
      const nodeTag = String(node.tagName || '').toUpperCase();
      const explicitContentEditable = nodeAttribute(node, 'contenteditable').toLowerCase();
      const mention = mentionIdentity(node);
      const explicitlyNonEditable = explicitContentEditable === 'false';
      if (mention) {
        decorations.push(mention);
        return '';
      }
      if (explicitlyNonEditable) {
        ambiguous = true;
        return '';
      }
      if (interactiveTags.has(nodeTag)) {
        ambiguous = true;
        return '';
      }
      if (nodeTag === 'BR') return '\n';
      const children = nodeChildren(node);
      if (children.length > 0
        && String(node.textContent ?? '') === ''
        && children.every(child => child?.nodeType === 1 && String(child?.tagName || '').toUpperCase() === 'BR')) {
        return '';
      }
      return children.map((child, index) => {
        const previous = children[index - 1];
        const next = children[index + 1];
        if (child?.nodeType === 3 && /^\s*$/.test(String(child.data ?? child.nodeValue ?? ''))) {
          if (isMention(previous) || isMention(next)) return '';
        }
        if (child?.nodeType === 1
          && typeof child.hasAttribute === 'function'
          && child.hasAttribute('data-prompt-literal-paste')
          && /^\s*$/.test(String(child.textContent ?? ''))
          && (isMention(previous) || isMention(next))) {
          return '';
        }
        return nodeText(child);
      }).join('');
    };
    const children = nodeChildren(composer);
    const hasBlockChildren = children.some(child => child?.nodeType === 1 && blockTags.has(String(child?.tagName || '').toUpperCase()));
    let composerText;
    let composerLineTags = [];
    if (!hasBlockChildren) {
      composerText = nodeText(composer);
    } else {
      const logicalLines = [];
      let inlineBuffer = '';
      let inlineSeen = false;
      const flushInline = () => {
        if (!inlineSeen) return;
        logicalLines.push({ text: inlineBuffer, tagName: '' });
        inlineBuffer = '';
        inlineSeen = false;
      };
      for (const child of children) {
        const childTag = child?.nodeType === 1 ? String(child?.tagName || '').toUpperCase() : '';
        if (blockTags.has(childTag)) {
          flushInline();
          logicalLines.push({ text: nodeText(child), tagName: childTag });
        } else {
          inlineBuffer += nodeText(child);
          inlineSeen = true;
        }
      }
      flushInline();
      composerText = logicalLines.map(line => line.text).join('\n');
      composerLineTags = logicalLines.flatMap(line => String(line.text).split('\n').map(() => line.tagName));
    }
    return {
      href: location.href,
      origin: location.origin,
      composerFound: true,
      composerAmbiguous: ambiguous,
      composerText: ambiguous ? '' : composerText,
      composerLineTags: ambiguous ? [] : composerLineTags,
      composerDecorations: ambiguous ? [] : decorations,
      composerDecorationFingerprint: ambiguous ? '' : JSON.stringify(decorations),
      rawComposerText: String(composer.textContent ?? ''),
    };
  }

  if (operationId === 'chatgptObserveProviderUsers') {
    const chatGptHosts = new Set(['chatgpt.com', 'chat.openai.com']);
    if (!chatGptHosts.has(String(location?.hostname || '').toLowerCase())) {
      throw new Error(`Fixed ChatGPT provider-user observation rejected non-ChatGPT page: ${String(location?.href || '')}`);
    }
    const userHeadingLabels = new Set(['你说：', 'You said:', 'User:']);
    const boundedText = element => {
      const text = String(element?.innerText ?? element?.textContent ?? '');
      if (text.length > 500_000) throw new Error('Fixed ChatGPT provider-user observation exceeded the per-turn text bound.');
      return text;
    };
    const stableAttribute = element => {
      if (!element || typeof element.getAttribute !== 'function') return '';
      for (const name of ['data-message-id', 'data-turn-id', 'data-testid', 'id']) {
        const value = String(element.getAttribute(name) || '').trim();
        if (value && value.length <= 512) return `${name}:${value}`;
      }
      return '';
    };
    const attributeValue = (element, name) => {
      if (!element || typeof element.getAttribute !== 'function') return '';
      const value = String(element.getAttribute(name) || '').trim();
      return value.length <= 512 ? value : '';
    };
    const hasAttributeName = (element, name) => {
      if (!element) return false;
      if (typeof element.hasAttribute === 'function') return element.hasAttribute(name);
      if (typeof element.getAttribute === 'function') return element.getAttribute(name) !== null;
      return false;
    };
    const ancestorWithAttribute = (element, name, maxDepth = 18) => {
      let current = element;
      for (let depth = 0; current && depth < maxDepth; depth += 1, current = current.parentElement) {
        if (hasAttributeName(current, name)) return current;
      }
      return null;
    };
    const classTokens = element => new Set(String(element?.getAttribute?.('class') || '').split(/\s+/).filter(Boolean));
    const hasTokens = (element, required) => {
      const tokens = classTokens(element);
      return required.every(token => tokens.has(token));
    };
    const fallbackPresentationKind = heading => {
      const block = heading?.parentElement;
      const first = block?.parentElement;
      const second = first?.parentElement;
      const third = second?.parentElement;
      if (hasTokens(first, ['flex', 'flex-col', 'gap-3', 'browser:gap-1'])
        && hasTokens(second, ['group', 'flex', 'flex-col', 'pb-2', 'pt-2'])) {
        return 'provider-user-turn';
      }
      const virtualizedContext = hasAttributeName(first, 'data-virtualized-turn-content')
        && hasTokens(first, ['flex', 'flex-col', 'gap-0']);
      const liveContext = hasTokens(first, ['flex', 'flex-col'])
        && !classTokens(first).has('gap-3')
        && hasTokens(second, ['flex', 'flex-col', 'gap-0'])
        && hasTokens(third, ['group', 'flex', 'flex-col']);
      if (virtualizedContext || liveContext) return 'work-context-turn';
      return 'unknown-user-turn';
    };
    const structuralIdentity = ({ content, owner, heading }) => {
      const direct = stableAttribute(owner) || stableAttribute(content);
      if (direct) return { identity: direct, identitySource: direct.split(':', 1)[0], identityStable: true };
      const turnRoot = ancestorWithAttribute(heading || content || owner, 'data-turn-key');
      const turnKey = attributeValue(turnRoot, 'data-turn-key');
      if (turnKey) return { identity: `data-turn-key:${turnKey}`, identitySource: 'data-turn-key', identityStable: true };
      const messageIds = attributeValue(content, 'data-chatgpt-search-message-ids');
      if (messageIds && !/\s/.test(messageIds)) {
        return { identity: `data-chatgpt-search-message-ids:${messageIds}`, identitySource: 'data-chatgpt-search-message-ids', identityStable: true };
      }
      return { identity: '', identitySource: 'none', identityStable: false };
    };
    const semanticLineTag = element => {
      const semanticBlock = element?.matches?.('pre, code') || element?.querySelector?.('pre, code');
      return semanticBlock ? 'PRE' : 'USER_TEXT';
    };
    const inlineCodeRepresentation = (content, text) => {
      const bodies = [...(content.querySelectorAll?.('.whitespace-pre-wrap') || [])];
      if (bodies.length !== 1) return '';
      const body = bodies[0];
      const original = String(body.innerText ?? '');
      if (!original || !text.startsWith(original) || body.closest?.('pre, code')) return '';
      let codeCount = 0;
      const parts = [];
      const plainParts = [];
      for (const node of [...(body.childNodes || [])]) {
        if (node.nodeType === 3) {
          const value = String(node.data ?? node.nodeValue ?? '');
          parts.push(value); plainParts.push(value); continue;
        }
        if (node.nodeType !== 1 || String(node.tagName).toUpperCase() !== 'CODE') return '';
        const children = [...(node.childNodes || [])];
        const value = String(node.textContent ?? '');
        if (!value || value.length > 4096 || /[`\r\n]/.test(value)
          || children.some(child => child.nodeType !== 3) || ++codeCount > 64) return '';
        parts.push('`', value, '`');
        plainParts.push(value);
      }
      if (!codeCount || plainParts.join('') !== original) return '';
      // Keep every other byte, including existing collapse chrome. The host
      // may accept this representation only against the whole expected prompt.
      const candidate = parts.join('') + text.slice(original.length);
      return candidate.length <= 500_000 ? candidate : '';
    };
    const explicit = [...new Set([
      ...document.querySelectorAll('main [data-message-author-role="user"]'),
      ...document.querySelectorAll('main [data-role="user"]'),
    ])];
    let candidates = [];
    if (explicit.length > 0) {
      candidates = explicit.map((content, index) => {
        const owner = content.closest?.('article') || content;
        const structural = structuralIdentity({ content, owner });
        return {
          content,
          owner,
          ...structural,
          presentationKind: 'explicit-role-user',
          virtualized: !!ancestorWithAttribute(content, 'data-virtualized-turn-content'),
        };
      });
    } else {
      const headings = [...new Set([
        ...document.querySelectorAll('main h4'),
        ...document.querySelectorAll('h4'),
      ])].filter(heading => userHeadingLabels.has(String(heading?.innerText ?? heading?.textContent ?? '').trim()));
      candidates = headings.map((heading, index) => {
        const content = heading?.nextElementSibling;
        const owner = heading?.closest?.('article') || heading?.parentElement || content;
        const structural = structuralIdentity({ content, owner, heading });
        return {
          content,
          owner,
          heading,
          ...structural,
          presentationKind: fallbackPresentationKind(heading),
          virtualized: !!ancestorWithAttribute(heading, 'data-virtualized-turn-content'),
        };
      });
    }
    if (candidates.length > 80) {
      return { href: location.href, origin: location.origin, userTurns: [], providerUsersAmbiguous: true, reason: 'too-many-provider-user-turns' };
    }
    const seenIdentities = new Set();
    const userTurns = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const content = candidate?.content;
      if (!content || content.nodeType !== 1) {
        return { href: location.href, origin: location.origin, userTurns: [], providerUsersAmbiguous: true, reason: 'provider-user-content-root-missing' };
      }
      const identity = String(candidate.identity || '');
      if (!identity || candidate.identityStable !== true) {
        return { href: location.href, origin: location.origin, userTurns: [], providerUsersAmbiguous: true, reason: 'unstable-provider-user-identity' };
      }
      if (seenIdentities.has(identity)) {
        return { href: location.href, origin: location.origin, userTurns: [], providerUsersAmbiguous: true, reason: 'duplicate-provider-user-identity' };
      }
      seenIdentities.add(identity);
      const text = boundedText(content);
      const lineTag = semanticLineTag(content);
      userTurns.push({
        identity,
        text,
        inlineCodeText: inlineCodeRepresentation(content, text),
        lineTags: text.split('\n').map(() => lineTag),
        identitySource: String(candidate.identitySource || ''),
        identityStable: true,
        presentationKind: String(candidate.presentationKind || 'unknown-user-turn'),
        virtualized: candidate.virtualized === true,
      });
    }
    return {
      href: location.href,
      origin: location.origin,
      userTurns,
      providerUserRepresentationVersion: 2,
      providerUsersAmbiguous: false,
    };
  }

  const createSiteAdapter = (0, eval)(`(${String(siteAdapterSource || '').trim()})`);
  const site = createSiteAdapter({ window, document, location, visible, storage: sessionStorage });

  function readState() {
    const runtime = window.__shuncodeWebMcp;
    let runtimeStatus = null;
    let runtimeSession = null;
    try { runtimeStatus = runtime && typeof runtime.status === 'function' ? runtime.status() : null; } catch {}
    try { runtimeSession = runtime && typeof runtime.workerSession === 'function' ? runtime.workerSession() : null; } catch {}
    let storedPageSessionId = '';
    try { storedPageSessionId = sessionStorage.getItem('shuncode-webmcp-page-session-id') || ''; } catch {}
    return { runtime, runtimeStatus, runtimeSession, storedPageSessionId };
  }

  function observation() {
    const { runtime, runtimeStatus, runtimeSession, storedPageSessionId } = readState();
    return {
      href: location.href,
      origin: location.origin,
      site: String(site?.id || ''),
      composerFound: !!site?.findComposer?.(),
      isDeepSeekAuthPage: site?.isDeepSeekAuthPage === true,
      runtimeVersion: Number(runtime?.version || 0) || null,
      runtimeEnabled: runtimeStatus?.enabled === true,
      runtimePageSessionId: String(runtimeSession?.sessionId || runtimeStatus?.pageSessionId || ''),
      storedPageSessionId,
      workerTurnState: String(runtimeStatus?.workerTurn?.state || ''),
    };
  }

  if (operationId === 'observe') {
    return observation();
  }

  const nativeBypassHosts = new Set(['chatgpt.com', 'chat.openai.com']);

  if (operationId === 'control') {
    const control = input?.control;
    if (!control || typeof control !== 'object' || Array.isArray(control)) throw new Error('WebMCP fixed Worker control payload is missing.');
    const action = String(control.action || '').trim();
    const allowedActions = new Set(['send', 'poll', 'interrupt', 'resolve', 'health', 'disconnect']);
    if (!allowedActions.has(action)) throw new Error(`Unsupported fixed WebMCP Worker control action: ${action}`);
    const requestedSessionId = String(control.sessionId || '').trim();
    const expectedOrigin = String(control.expectedOrigin || '').trim();
    const expectedHref = String(control.expectedHref || '').trim();
    const expectedSite = String(control.expectedSite || '').trim();
    if (!requestedSessionId || !expectedOrigin || !expectedHref || !expectedSite) throw new Error('WebMCP fixed Worker control requires sessionId, expectedOrigin, expectedHref and expectedSite.');
    if (expectedHref.length > 2048) throw new Error('WebMCP fixed Worker control expectedHref is too large.');

    const currentHost = String(location.hostname || '').toLowerCase();
    if (nativeBypassHosts.has(currentHost)) throw new Error(`WebMCP Worker control rejected native-MCP bypass target: ${location.href}`);
    const currentSite = String(site?.id || '');
    if (location.origin !== expectedOrigin || currentSite !== expectedSite) throw new Error(`WebMCP Worker control page lineage changed: ${location.href}`);
    if (action === 'send' && location.href !== expectedHref) throw new Error(`WebMCP Worker control href lineage changed before send: ${location.href}`);

    const { runtime, runtimeStatus, runtimeSession, storedPageSessionId } = readState();
    const runtimeSessionId = String(runtimeSession?.sessionId || '');
    const statusPageSessionId = String(runtimeStatus?.pageSessionId || '');
    if (!runtime || runtime.version !== 25 || typeof runtime.workerSession !== 'function' || runtimeStatus?.enabled !== true) {
      throw new Error('WebMCP v25 Worker runtime is unavailable for fixed control.');
    }
    if (!runtimeSessionId
      || runtimeSessionId !== requestedSessionId
      || statusPageSessionId !== requestedSessionId
      || String(storedPageSessionId || '') !== requestedSessionId) {
      throw new Error(`WebMCP Worker page session identity changed before ${action}.`);
    }
    if (String(runtimeSession?.site || '') !== currentSite
      || String(runtimeSession?.origin || '') !== location.origin
      || String(runtimeSession?.href || '') !== location.href) {
      throw new Error(`WebMCP Worker runtime lineage disagrees with the current page before ${action}.`);
    }

    const withControlLineage = async value => {
      const result = await value;
      const post = readState();
      const postRuntimeSessionId = String(post.runtimeSession?.sessionId || '');
      const postStatusPageSessionId = String(post.runtimeStatus?.pageSessionId || '');
      if (!postRuntimeSessionId
        || postRuntimeSessionId !== requestedSessionId
        || postStatusPageSessionId !== requestedSessionId
        || String(post.storedPageSessionId || '') !== requestedSessionId) {
        throw new Error(`WebMCP Worker page session identity changed after ${action}.`);
      }
      if (String(post.runtimeSession?.site || '') !== currentSite
        || String(post.runtimeSession?.origin || '') !== location.origin
        || String(post.runtimeSession?.href || '') !== location.href) {
        throw new Error(`WebMCP Worker runtime lineage disagrees with the current page after ${action}.`);
      }
      if (!result || typeof result !== 'object' || Array.isArray(result)) {
        throw new Error(`WebMCP Worker ${action} returned a non-object result.`);
      }
      return {
        ...result,
        controlLineage: {
          sessionId: requestedSessionId,
          origin: location.origin,
          href: location.href,
          site: currentSite,
        },
      };
    };

    if (action === 'health') return { session: runtimeSession, status: runtimeStatus };
    if (action === 'send') {
      const inputValue = control.input;
      if (!inputValue || typeof inputValue !== 'object' || Array.isArray(inputValue) || !String(inputValue.inputId || '').trim()) throw new Error('WebMCP Worker send requires structured input with inputId.');
      if (typeof runtime.workerSend !== 'function') throw new Error('WebMCP Worker send is unavailable.');
      return withControlLineage(runtime.workerSend(inputValue));
    }
    if (action === 'poll') {
      const inputId = String(control.inputId || '').trim();
      if (!inputId) throw new Error('WebMCP Worker poll requires inputId.');
      if (typeof runtime.workerPoll !== 'function') throw new Error('WebMCP Worker poll is unavailable.');
      return withControlLineage(runtime.workerPoll(inputId));
    }
    if (action === 'interrupt') {
      const inputId = String(control.inputId || '').trim();
      if (!inputId) throw new Error('WebMCP Worker interrupt requires inputId.');
      const activeInputId = String(runtimeStatus?.workerTurn?.inputId || '');
      if (activeInputId && activeInputId !== inputId) throw new Error(`WebMCP Worker interrupt inputId does not match the active turn: ${inputId}`);
      if (typeof runtime.workerInterrupt !== 'function' || typeof runtime.workerPoll !== 'function') throw new Error('WebMCP Worker interrupt is unavailable.');
      return (async () => ({ interrupted: await runtime.workerInterrupt(inputId), turn: await runtime.workerPoll(inputId) }))();
    }
    if (action === 'resolve') {
      const result = control.result;
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('WebMCP Worker resolve requires a structured result.');
      const inputId = String(result.inputId || '').trim();
      const callId = String(result.callId || '').trim();
      const name = String(result.name || '').trim();
      if (!inputId || !callId || !name) throw new Error('WebMCP Worker resolve requires inputId, callId and capability name.');
      const activeInputId = String(runtimeStatus?.workerTurn?.inputId || '');
      if (activeInputId && activeInputId !== inputId) throw new Error(`WebMCP Worker resolve inputId does not match the active turn: ${inputId}`);
      if (typeof runtime.workerResolveCapability !== 'function') throw new Error('WebMCP Worker resolve is unavailable.');
      return runtime.workerResolveCapability(result);
    }
    if (action === 'disconnect') {
      if (typeof runtime.workerInterrupt !== 'function') throw new Error('WebMCP Worker disconnect is unavailable.');
      return (async () => {
        const status = runtime.status();
        if (status?.workerTurn?.state === 'running') await runtime.workerInterrupt(status.workerTurn.inputId);
        return { disconnected: true, session: runtime.workerSession() };
      })();
    }
  }

  if (operationId !== 'connect') {
    throw new Error(`Unsupported fixed WebMCP browser operation: ${String(operationId || '')}`);
  }

  const target = input?.target;
  if (!target || typeof target !== 'object') throw new Error('WebMCP exact target is missing.');
  const pageId = String(target.pageId || '').trim();
  const resourceIdentity = String(target.resourceIdentity || '').trim();
  const expectedOrigin = String(target.origin || '').trim();
  const expectedHref = String(target.href || '').trim();
  const expectedSite = String(target.site || '').trim();
  const expectedPageSessionId = String(target.pageSessionId || '').trim();
  const bridgePort = Number(input?.bridgePort);
  const token = String(input?.token || '');
  if (!pageId || !resourceIdentity || !expectedOrigin || !expectedHref || !expectedSite) {
    throw new Error('WebMCP exact target requires pageId, resourceIdentity, origin, href and site.');
  }
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535) {
    throw new Error('WebMCP internal connect requires a valid loopback bridge port.');
  }
  if (!token || token.length > 512) {
    throw new Error('WebMCP internal connect requires a bounded page token.');
  }

  const before = observation();
  const currentHost = String(location.hostname || '').toLowerCase();
  const currentPageSessionId = String(before.runtimePageSessionId || before.storedPageSessionId || '');
  const sessionIdentityCompatible = !before.runtimePageSessionId
    || !before.storedPageSessionId
    || before.runtimePageSessionId === before.storedPageSessionId;
  const runtimePresent = before.runtimeVersion !== null;
  const runtimeCompatible = !runtimePresent
    || (before.runtimeVersion === 25 && before.runtimeEnabled === true && !!currentPageSessionId);
  const changed = before.origin !== expectedOrigin
    || before.href !== expectedHref
    || before.site !== expectedSite
    || currentPageSessionId !== expectedPageSessionId;
  if (changed) throw new Error(`Selected WebMCP page identity changed before connect: ${pageId}`);
  if (nativeBypassHosts.has(currentHost)) throw new Error(`Selected WebMCP page became a native-MCP bypass target: ${before.href}`);
  if (!sessionIdentityCompatible || !runtimeCompatible || !before.composerFound || before.isDeepSeekAuthPage || before.workerTurnState === 'running') {
    throw new Error(`Selected WebMCP page is not ready before connect: ${before.href}`);
  }

  const createCore = (0, eval)(`(${String(pageCoreSource || '').trim()})`);
  const agent = (0, eval)(`(${String(agentBridgeSource || '').trim()})`);
  agent({ bridge: `http://127.0.0.1:${bridgePort}`, token }, { createCore, createSiteAdapter });

  const injected = readState();
  const injectedWorkerSessionId = String(injected.runtimeSession?.sessionId || '');
  const injectedStatusPageSessionId = String(injected.runtimeStatus?.pageSessionId || '');
  const injectedStoredSessionId = String(injected.storedPageSessionId || '');
  if (!injectedWorkerSessionId
    || injectedWorkerSessionId !== injectedStatusPageSessionId
    || injectedWorkerSessionId !== injectedStoredSessionId) {
    throw new Error(`Selected WebMCP page session identity is inconsistent after injection: ${pageId}`);
  }
  if (expectedPageSessionId && injectedWorkerSessionId !== expectedPageSessionId) {
    throw new Error(`Selected WebMCP page session identity changed during injection: ${pageId}`);
  }

  return (async () => {
    const prime = input?.prime === true ? await window.__shuncodeWebMcp.prime() : null;
    const postSiteAdapter = createSiteAdapter({ window, document, location, visible, storage: sessionStorage });
    const post = readState();
    const postHref = location.href;
    const postOrigin = location.origin;
    const postHost = String(location.hostname || '').toLowerCase();
    const postSite = String(postSiteAdapter?.id || '');
    const postComposerFound = !!postSiteAdapter?.findComposer?.();
    const postIsAuthPage = postSiteAdapter?.isDeepSeekAuthPage === true;
    const postRuntimeVersion = Number(post.runtime?.version || 0) || null;
    const postRuntimeEnabled = post.runtimeStatus?.enabled === true;
    const postWorkerTurnState = String(post.runtimeStatus?.workerTurn?.state || '');
    const workerSession = post.runtimeSession;
    const workerSessionId = String(workerSession?.sessionId || '');
    const statusPageSessionId = String(post.runtimeStatus?.pageSessionId || '');
    const storedPageSessionIdAfter = String(post.storedPageSessionId || '');

    if (postOrigin !== expectedOrigin || postSite !== expectedSite) {
      throw new Error(`Selected WebMCP page identity changed after connect began: ${pageId}`);
    }
    if (nativeBypassHosts.has(postHost)) {
      throw new Error(`Selected WebMCP page became a native-MCP bypass target after connect began: ${postHref}`);
    }
    if (!postComposerFound || postIsAuthPage || postRuntimeVersion !== 25 || !postRuntimeEnabled || postWorkerTurnState === 'running') {
      throw new Error(`Selected WebMCP page is not ready after connect began: ${postHref}`);
    }
    if (String(workerSession?.site || '') !== postSite
      || String(workerSession?.origin || '') !== postOrigin
      || String(workerSession?.href || '') !== postHref) {
      throw new Error(`Selected WebMCP worker session lineage disagrees with the current page: ${pageId}`);
    }
    if (!workerSessionId
      || workerSessionId !== statusPageSessionId
      || workerSessionId !== storedPageSessionIdAfter) {
      throw new Error(`Selected WebMCP page session identity is inconsistent after connect: ${pageId}`);
    }
    if (workerSessionId !== injectedWorkerSessionId) {
      throw new Error(`Selected WebMCP page session generation changed after injection: ${pageId}`);
    }
    if (expectedPageSessionId && workerSessionId !== expectedPageSessionId) {
      throw new Error(`Selected WebMCP page session identity changed during connect: ${pageId}`);
    }
    return { status: post.runtimeStatus, prime, workerSession, url: postHref };
  })();
})

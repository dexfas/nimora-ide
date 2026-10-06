const { createHash } = require('node:crypto');

const MAX_SHARED_WORKER_PAGES = 32;

function parseSharedBrowserPages(text) {
  const pages = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/- \[([0-9a-f-]{36})\]\s+(.+?)\s+\((https?:\/\/[^)]+)\)(.*)$/i);
    if (!match) continue;
    pages.push({ pageId: match[1], title: match[2], url: match[3], visible: !/not visible/i.test(match[4] || '') });
    if (pages.length >= MAX_SHARED_WORKER_PAGES) break;
  }
  return pages;
}

function normalizedOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : '';
  } catch {
    return '';
  }
}

function boundedHref(value) {
  const text = String(value || '');
  return text.length <= 2048 ? text : text.slice(0, 2048);
}

function resourceIdentityFor(pageId, observation) {
  return createHash('sha256').update([
    String(pageId || ''),
    String(observation?.origin || ''),
    String(observation?.href || ''),
    String(observation?.site || ''),
    String(observation?.pageSessionId || ''),
  ].join('\u0000')).digest('hex');
}

function buildReadOnlyProbeCode(siteAdapterSource) {
  const factorySource = `(${String(siteAdapterSource || '').trim()})`;
  return `
    const factorySource = ${JSON.stringify(factorySource)};
    return await page.evaluate(source => {
      const createSiteAdapter = (0, eval)(source);
      const visible = element => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
      const site = createSiteAdapter({ window, document, location, visible, storage: sessionStorage });
      const runtime = window.__shuncodeWebMcp;
      let runtimeStatus = null;
      let runtimeSession = null;
      try { runtimeStatus = runtime && typeof runtime.status === 'function' ? runtime.status() : null; } catch {}
      try { runtimeSession = runtime && typeof runtime.workerSession === 'function' ? runtime.workerSession() : null; } catch {}
      let storedPageSessionId = '';
      try { storedPageSessionId = sessionStorage.getItem('shuncode-webmcp-page-session-id') || ''; } catch {}
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
    }, factorySource);
  `;
}

function buildExactConnectCode(siteAdapterSource, agentExpression, target, shouldPrime, nativeBypassHosts = []) {
  if (!target || typeof target !== 'object') throw new Error('WebMCP exact target is missing.');
  const pageId = String(target.pageId || '').trim();
  const resourceIdentity = String(target.resourceIdentity || '').trim();
  const origin = normalizedOrigin(target.origin);
  const href = boundedHref(target.href);
  const site = String(target.site || '').trim();
  const pageSessionId = String(target.pageSessionId || '').trim();
  if (!pageId || !resourceIdentity || !origin || !href || !site) {
    throw new Error('WebMCP exact target requires pageId, resourceIdentity, origin, href and site.');
  }
  const payload = {
    pageId,
    resourceIdentity,
    origin,
    href,
    site,
    pageSessionId,
    siteAdapterSource: `(${String(siteAdapterSource || '').trim()})`,
    agentExpression: String(agentExpression || ''),
    shouldPrime: shouldPrime === true,
    nativeBypassHosts: [...new Set((nativeBypassHosts || []).map(value => String(value || '').trim().toLowerCase()).filter(Boolean))],
  };
  return `
    const payload = ${JSON.stringify(payload)};
    return await page.evaluate(async payload => {
      const createSiteAdapter = (0, eval)(payload.siteAdapterSource);
      const visible = element => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
      const site = createSiteAdapter({ window, document, location, visible, storage: sessionStorage });
      const runtime = window.__shuncodeWebMcp;
      let runtimeStatus = null;
      let runtimeSession = null;
      try { runtimeStatus = runtime && typeof runtime.status === 'function' ? runtime.status() : null; } catch {}
      try { runtimeSession = runtime && typeof runtime.workerSession === 'function' ? runtime.workerSession() : null; } catch {}
      let storedPageSessionId = '';
      try { storedPageSessionId = sessionStorage.getItem('shuncode-webmcp-page-session-id') || ''; } catch {}
      const runtimePageSessionId = String(runtimeSession?.sessionId || runtimeStatus?.pageSessionId || '');
      const currentPageSessionId = runtimePageSessionId || storedPageSessionId;
      const sessionIdentityCompatible = !runtimePageSessionId || !storedPageSessionId || runtimePageSessionId === storedPageSessionId;
      const runtimeVersion = Number(runtime?.version || 0) || null;
      const runtimePresent = runtimeVersion !== null;
      const runtimeCompatible = !runtimePresent || (runtimeVersion === 25 && runtimeStatus?.enabled === true && !!currentPageSessionId);
      const currentOrigin = location.origin;
      const currentHref = location.href;
      const currentSite = String(site?.id || '');
      const currentHost = String(location.hostname || '').toLowerCase();
      const composerFound = !!site?.findComposer?.();
      const isAuthPage = site?.isDeepSeekAuthPage === true;
      const workerTurnState = String(runtimeStatus?.workerTurn?.state || '');
      const changed = currentOrigin !== payload.origin
        || currentHref !== payload.href
        || currentSite !== payload.site
        || currentPageSessionId !== payload.pageSessionId;
      if (changed) throw new Error('Selected WebMCP page identity changed before connect: ' + payload.pageId);
      if (payload.nativeBypassHosts.includes(currentHost)) throw new Error('Selected WebMCP page became a native-MCP bypass target: ' + currentHref);
      if (!sessionIdentityCompatible || !runtimeCompatible || !composerFound || isAuthPage || workerTurnState === 'running') {
        throw new Error('Selected WebMCP page is not ready before connect: ' + currentHref);
      }

      // First provider-conversation mutation in the exact-target path. The
      // identity/readiness checks above are synchronous in this same page task.
      (0, eval)(payload.agentExpression);
      const injectedRuntime = window.__shuncodeWebMcp;
      let injectedStatus = null;
      let injectedWorkerSession = null;
      try { injectedStatus = injectedRuntime && typeof injectedRuntime.status === 'function' ? injectedRuntime.status() : null; } catch {}
      try { injectedWorkerSession = injectedRuntime && typeof injectedRuntime.workerSession === 'function' ? injectedRuntime.workerSession() : null; } catch {}
      let injectedStoredPageSessionId = '';
      try { injectedStoredPageSessionId = sessionStorage.getItem('shuncode-webmcp-page-session-id') || ''; } catch {}
      const injectedWorkerSessionId = String(injectedWorkerSession?.sessionId || '');
      const injectedStatusPageSessionId = String(injectedStatus?.pageSessionId || '');
      const injectedStoredSessionId = String(injectedStoredPageSessionId || '');
      if (!injectedWorkerSessionId
        || injectedWorkerSessionId !== injectedStatusPageSessionId
        || injectedWorkerSessionId !== injectedStoredSessionId) {
        throw new Error('Selected WebMCP page session identity is inconsistent after injection: ' + payload.pageId);
      }
      if (payload.pageSessionId && injectedWorkerSessionId !== payload.pageSessionId) {
        throw new Error('Selected WebMCP page session identity changed during injection: ' + payload.pageId);
      }
      const prime = payload.shouldPrime ? await window.__shuncodeWebMcp.prime() : null;

      // Provider conversation creation may evolve the route (for example from a
      // model-selection route to a provider-native conversation route). Re-read
      // all session-lineage facts after that accepted mutation rather than
      // treating the admission href as immutable session identity.
      const postSiteAdapter = createSiteAdapter({ window, document, location, visible, storage: sessionStorage });
      const postRuntime = window.__shuncodeWebMcp;
      let postStatus = null;
      let workerSession = null;
      try { postStatus = postRuntime && typeof postRuntime.status === 'function' ? postRuntime.status() : null; } catch {}
      try { workerSession = postRuntime && typeof postRuntime.workerSession === 'function' ? postRuntime.workerSession() : null; } catch {}
      let postStoredPageSessionId = '';
      try { postStoredPageSessionId = sessionStorage.getItem('shuncode-webmcp-page-session-id') || ''; } catch {}

      const postHref = location.href;
      const postOrigin = location.origin;
      const postHost = String(location.hostname || '').toLowerCase();
      const postSite = String(postSiteAdapter?.id || '');
      const postComposerFound = !!postSiteAdapter?.findComposer?.();
      const postIsAuthPage = postSiteAdapter?.isDeepSeekAuthPage === true;
      const postRuntimeVersion = Number(postRuntime?.version || 0) || null;
      const postRuntimeEnabled = postStatus?.enabled === true;
      const postWorkerTurnState = String(postStatus?.workerTurn?.state || '');
      const workerSessionId = String(workerSession?.sessionId || '');
      const statusPageSessionId = String(postStatus?.pageSessionId || '');
      const storedPageSessionIdAfter = String(postStoredPageSessionId || '');
      const finalPageSessionId = workerSessionId;

      if (postOrigin !== payload.origin || postSite !== payload.site) {
        throw new Error('Selected WebMCP page identity changed after connect began: ' + payload.pageId);
      }
      if (payload.nativeBypassHosts.includes(postHost)) {
        throw new Error('Selected WebMCP page became a native-MCP bypass target after connect began: ' + postHref);
      }
      if (!postComposerFound || postIsAuthPage || postRuntimeVersion !== 25 || !postRuntimeEnabled || postWorkerTurnState === 'running') {
        throw new Error('Selected WebMCP page is not ready after connect began: ' + postHref);
      }
      if (String(workerSession?.site || '') !== postSite
        || String(workerSession?.origin || '') !== postOrigin
        || String(workerSession?.href || '') !== postHref) {
        throw new Error('Selected WebMCP worker session lineage disagrees with the current page: ' + payload.pageId);
      }
      if (!finalPageSessionId
        || finalPageSessionId !== statusPageSessionId
        || finalPageSessionId !== storedPageSessionIdAfter) {
        throw new Error('Selected WebMCP page session identity is inconsistent after connect: ' + payload.pageId);
      }
      if (finalPageSessionId !== injectedWorkerSessionId) {
        throw new Error('Selected WebMCP page session generation changed after injection: ' + payload.pageId);
      }
      if (payload.pageSessionId && finalPageSessionId !== payload.pageSessionId) {
        throw new Error('Selected WebMCP page session identity changed during connect: ' + payload.pageId);
      }
      return { status: postStatus, prime, workerSession, url: postHref };
    }, payload);
  `;
}

function normalizeObservedResource(page, value, nativeMcpBypass = false) {
  const href = boundedHref(value?.href || page?.url || '');
  const origin = normalizedOrigin(value?.origin || href);
  const runtimePageSessionId = String(value?.runtimePageSessionId || '').trim();
  const storedPageSessionId = String(value?.storedPageSessionId || '').trim();
  const pageSessionId = runtimePageSessionId || storedPageSessionId || undefined;
  const sessionIdentityCompatible = !runtimePageSessionId || !storedPageSessionId || runtimePageSessionId === storedPageSessionId;
  const runtimeVersion = Number(value?.runtimeVersion || 0) || undefined;
  const workerTurnState = String(value?.workerTurnState || '').trim() || undefined;
  const site = String(value?.site || '').trim();
  const composerFound = value?.composerFound === true;
  const isDeepSeekAuthPage = value?.isDeepSeekAuthPage === true;
  const runtimePresent = runtimeVersion !== undefined;
  const runtimeCompatible = !runtimePresent || (runtimeVersion === 25 && value?.runtimeEnabled === true && !!pageSessionId);
  const ready = !nativeMcpBypass
    && !!origin
    && !!site
    && composerFound
    && !isDeepSeekAuthPage
    && sessionIdentityCompatible
    && runtimeCompatible
    && workerTurnState !== 'running';
  const observation = {
    pageId: String(page?.pageId || ''),
    title: String(page?.title || ''),
    visible: page?.visible === true,
    href,
    origin,
    site,
    nativeMcpBypass,
    composerFound,
    isDeepSeekAuthPage,
    runtimeVersion,
    runtimeEnabled: value?.runtimeEnabled === true,
    workerTurnState,
    pageSessionId,
    sessionIdentityCompatible,
    ready,
  };
  return { ...observation, resourceIdentity: resourceIdentityFor(observation.pageId, observation) };
}

function normalizeBypassResource(page) {
  return normalizeObservedResource(page, {
    href: page?.url || '',
    origin: normalizedOrigin(page?.url || ''),
    site: '',
    composerFound: false,
    isDeepSeekAuthPage: false,
  }, true);
}

function assertExactTargetCompatible(target, observation) {
  if (!target || typeof target !== 'object') throw new Error('WebMCP exact target is missing.');
  const pageId = String(target.pageId || '').trim();
  const resourceIdentity = String(target.resourceIdentity || '').trim();
  if (!pageId || !resourceIdentity) throw new Error('WebMCP exact target requires pageId and resourceIdentity.');
  if (!observation || observation.pageId !== pageId) throw new Error(`Selected WebMCP page disappeared: ${pageId}`);
  if (observation.resourceIdentity !== resourceIdentity) {
    throw new Error(`Selected WebMCP page identity changed: ${pageId}`);
  }
  if (observation.nativeMcpBypass) throw new Error(`Selected WebMCP page is a native-MCP bypass target: ${observation.href || pageId}`);
  if (!observation.ready) throw new Error(`Selected WebMCP page is not ready: ${observation.href || pageId}`);
  return observation;
}

module.exports = {
  MAX_SHARED_WORKER_PAGES,
  parseSharedBrowserPages,
  buildReadOnlyProbeCode,
  buildExactConnectCode,
  normalizeObservedResource,
  normalizeBypassResource,
  assertExactTargetCompatible,
  resourceIdentityFor,
};

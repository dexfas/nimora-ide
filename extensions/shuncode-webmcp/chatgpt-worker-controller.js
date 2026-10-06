const chatGptResources = require('./chatgpt-worker-resources.js');
const workerPageResources = require('./worker-page-resources.js');

function createChatGptWorkerController(options) {
  const invokeBrowserTool = options.invokeBrowserTool;
  const ensureExactPageVisible = options.ensureExactPageVisible;
  const observeExactComposer = options.observeExactComposer;
  const observeExactProviderUsers = options.observeExactProviderUsers;
  const getSiteAdapterSource = options.getSiteAdapterSource;
  const resultText = options.resultText;
  const structuredValue = options.structuredValue;
  const now = options.now || Date.now;
  const sessions = new Map();
  const pageStates = new Map();

  function reconcileExpectedComposerObservation(observation, expectedPrompt) {
    const raw = String(observation?.composerText ?? '');
    const expected = String(expectedPrompt ?? '');
    const decorations = Array.isArray(observation?.composerDecorations) ? observation.composerDecorations : [];
    if (raw === expected) return observation;
    const expectedLines = expected.split('\n');
    const lineTags = Array.isArray(observation?.composerLineTags) ? observation.composerLineTags : [];
    // Try only the existing bounded representations. They can coexist in one
    // composer; admission still requires exact equality of the entire prompt.
    const candidates = [{ text: raw, leading: false }];
    if (decorations.length === 1 && raw.startsWith(' ')) {
      candidates.push({ text: raw.slice(1), leading: true });
    }
    for (const candidate of candidates) {
      const rawLines = candidate.text.split('\n');
      const tags = lineTags.slice();
      let trailing = false;
      if (rawLines.length === expectedLines.length + 1
        && tags.length === rawLines.length
        && rawLines[rawLines.length - 1] === ''
        && tags[tags.length - 1] === 'P') {
        rawLines.pop();
        tags.pop();
        trailing = true;
      }
      if (rawLines.length !== expectedLines.length) continue;
      const logical = rawLines.map((rawLine, index) => {
        const expectedLine = expectedLines[index];
        if (rawLine === expectedLine) return rawLine;
        if (tags.length === rawLines.length && tags[index] === 'P'
          && rawLine.startsWith('\u00a0 ') && expectedLine.startsWith('  ')
          && rawLine.slice(2) === expectedLine.slice(2)) return expectedLine;
        return rawLine;
      }).join('\n');
      if (logical !== expected) continue;
      return {
        ...observation,
        rawComposerText: raw,
        composerText: logical,
        composerRepresentationReconciled: true,
        composerLeadingDecorationSeparatorReconciled: candidate.leading,
        composerTrailingEmptyParagraphReconciled: trailing,
      };
    }
    return observation;
  }

  function composerDecorationFingerprint(observation) {
    if (typeof observation?.composerDecorationFingerprint === 'string') {
      return observation.composerDecorationFingerprint;
    }
    const decorations = Array.isArray(observation?.composerDecorations) ? observation.composerDecorations : [];
    return JSON.stringify(decorations);
  }

  function composerDecorationDisplayText(observation) {
    const decorations = Array.isArray(observation?.composerDecorations) ? observation.composerDecorations : [];
    if (decorations.length !== 1 || String(observation?.composerText ?? '') !== '') return '';
    const displayText = String(observation?.rawComposerText ?? '').trim();
    if (!displayText || displayText.length > 240 || displayText.includes('\n') || displayText.includes('\r')) return '';
    return displayText;
  }

  function reconcileExpectedProviderUserMessage(entry, expectedPrompt, workAppDisplayText = '') {
    const raw = String(entry?.text ?? '');
    const expected = String(expectedPrompt ?? '');
    if (raw === expected) return entry;
    const inlineCodeText = String(entry?.inlineCodeText || '');
    if (inlineCodeText && inlineCodeText !== raw && inlineCodeText.length <= 500_000
      && inlineCodeText.split('\n').length === raw.split('\n').length) {
      const candidate = reconcileExpectedProviderUserMessage({ ...entry, text: inlineCodeText, inlineCodeText: '' }, expected, workAppDisplayText);
      if (candidate.text === expected) return { ...candidate, rawText: raw, providerUserInlineCodeReconciled: true };
    }
    const expectedBodyLines = expected.split('\n');
    const bodyMatches = (body, tags) => {
      if (body === expected) return true;
      const lines = body.split('\n');
      if (lines.length !== expectedBodyLines.length || tags.length !== lines.length) return false;
      return lines.every((line, index) => line === expectedBodyLines[index]
        || (tags[index] === 'USER_TEXT' && line.startsWith('\u00a0 ')
          && expectedBodyLines[index].startsWith('  ')
          && line.slice(2) === expectedBodyLines[index].slice(2)));
    };
    const rawLineTags = Array.isArray(entry?.lineTags) ? entry.lineTags : [];
    const exactWorkAppDisplayText = String(workAppDisplayText || '').trim();
    const validWorkAppDisplayText = exactWorkAppDisplayText
      && exactWorkAppDisplayText.length <= 240
      && !exactWorkAppDisplayText.includes('\n')
      && !exactWorkAppDisplayText.includes('\r');
    if (validWorkAppDisplayText) {
      const prefix = `${exactWorkAppDisplayText}\n `;
      if (raw.startsWith(prefix)
        && bodyMatches(raw.slice(prefix.length, prefix.length + expected.length), rawLineTags.slice(1, 1 + expectedBodyLines.length))) {
        const suffix = raw.slice(prefix.length + expected.length);
        const acceptedCollapseSuffixes = new Set([
          '\n\n…\n显示更多',
          '\n\n...\n显示更多',
          '\n\n…\nShow more',
          '\n\n...\nShow more',
        ]);
        if (acceptedCollapseSuffixes.has(suffix)) {
          const rawLines = raw.split('\n');
          const expectedLines = expected.split('\n');
          const lineTags = Array.isArray(entry?.lineTags) ? entry.lineTags : [];
          if (lineTags.length === rawLines.length && lineTags.every(tag => tag === 'USER_TEXT')) {
            return {
              ...entry,
              rawText: raw,
              text: expected,
              lineTags: lineTags.slice(1, 1 + expectedLines.length),
              providerUserRepresentationReconciled: true,
              providerUserWorkAppChromeReconciled: true,
              providerUserWorkAppPrefixReconciled: true,
              providerUserWorkAppDisplayText: exactWorkAppDisplayText,
            };
          }
        }
      }
    }
    if (bodyMatches(raw.slice(0, expected.length), rawLineTags.slice(0, expectedBodyLines.length))) {
      const suffix = raw.slice(expected.length);
      if (/^\s*(?:(?:…|\.\.\.)\s*)?(?:显示更多|Show more)\s*$/iu.test(suffix)) {
        const expectedLineCount = expected.split('\n').length;
        return {
          ...entry,
          rawText: raw,
          text: expected,
          lineTags: Array.isArray(entry?.lineTags) ? entry.lineTags.slice(0, expectedLineCount) : entry?.lineTags,
          providerUserRepresentationReconciled: true,
          providerUserCollapsedChromeReconciled: true,
        };
      }
      if (validWorkAppDisplayText) {
        const acceptedSuffixes = new Set([
          `\n\n${exactWorkAppDisplayText}\n\n…\n显示更多`,
          `\n\n${exactWorkAppDisplayText}\n\n...\n显示更多`,
          `\n\n${exactWorkAppDisplayText}\n\n…\nShow more`,
          `\n\n${exactWorkAppDisplayText}\n\n...\nShow more`,
        ]);
        if (acceptedSuffixes.has(suffix)) {
          const rawLines = raw.split('\n');
          const expectedLines = expected.split('\n');
          const lineTags = Array.isArray(entry?.lineTags) ? entry.lineTags : [];
          const suffixProvenanceStart = Math.max(0, expectedLines.length - 1);
          if (lineTags.length === rawLines.length
            && lineTags.slice(suffixProvenanceStart).every(tag => tag === 'USER_TEXT')) {
            return {
              ...entry,
              rawText: raw,
              text: expected,
              lineTags: lineTags.slice(0, expectedLines.length),
              providerUserRepresentationReconciled: true,
              providerUserWorkAppChromeReconciled: true,
              providerUserWorkAppDisplayText: exactWorkAppDisplayText,
            };
          }
        }
      }
    }
    const rawLines = raw.split('\n');
    const expectedLines = expected.split('\n');
    const lineTags = Array.isArray(entry?.lineTags) ? entry.lineTags : [];
    if (rawLines.length !== expectedLines.length || lineTags.length !== rawLines.length) return entry;
    let reconciled = false;
    const logicalLines = rawLines.map((rawLine, index) => {
      const expectedLine = expectedLines[index];
      if (rawLine === expectedLine) return rawLine;
      if (lineTags[index] !== 'USER_TEXT') return rawLine;
      if (rawLine.startsWith('\u00a0 ')
        && expectedLine.startsWith('  ')
        && rawLine.slice(2) === expectedLine.slice(2)) {
        reconciled = true;
        return expectedLine;
      }
      return rawLine;
    });
    const logical = logicalLines.join('\n');
    if (!reconciled || logical !== expected) return entry;
    return {
      ...entry,
      rawText: raw,
      text: logical,
      providerUserRepresentationReconciled: true,
    };
  }

  function applyExactProviderUserObservation(observation, exactProviderUsers) {
    if (!exactProviderUsers || typeof exactProviderUsers !== 'object') {
      throw new Error('ChatGPT exact provider-user observation returned no structured result.');
    }
    if (String(exactProviderUsers.href || '') !== String(observation.href || '')
      || String(exactProviderUsers.origin || '') !== String(observation.origin || '')) {
      throw new Error('ChatGPT exact provider-user observation page lineage changed.');
    }
    if (exactProviderUsers.providerUsersAmbiguous === true) {
      throw new Error('ChatGPT exact provider-user observation is ambiguous: ' + String(exactProviderUsers.reason || 'unknown'));
    }
    if (exactProviderUsers.providerUserRepresentationVersion !== 2) {
      throw new Error('ChatGPT fixed provider-user reader is stale; reload the workbench before sending any new request.');
    }
    const turns = Array.isArray(exactProviderUsers.userTurns) ? exactProviderUsers.userTurns : [];
    if (turns.length > 80) throw new Error('ChatGPT exact provider-user observation exceeded the bounded turn count.');
    const identities = new Set();
    const exactMessages = turns.map((turn, index) => {
      const identity = String(turn?.identity || '').trim();
      const text = String(turn?.text ?? '');
      const lineTags = Array.isArray(turn?.lineTags) ? turn.lineTags.map(tag => String(tag || '').toUpperCase()) : [];
      if (!identity || identities.has(identity)) {
        throw new Error('ChatGPT exact provider-user observation has an invalid or duplicate identity.');
      }
      if (lineTags.length !== text.split('\n').length) {
        throw new Error('ChatGPT exact provider-user observation has invalid line provenance.');
      }
      identities.add(identity);
      return {
        role: 'user',
        key: `fixed-provider-user:${identity}`,
        text,
        lineTags,
        inlineCodeText: String(turn?.inlineCodeText || ''),
        ordinal: index,
        identitySource: String(turn?.identitySource || ''),
        identityStable: turn?.identityStable === true,
        presentationKind: String(turn?.presentationKind || 'unknown-user-turn'),
        virtualized: turn?.virtualized === true,
      };
    });
    const state = pageStates.get(String(observation.pageId || ''));
    const ownedSession = [...sessions.values()].find(session => session.pageId === String(observation.pageId || ''));
    const activeTurn = ownedSession?.activeTurn;
    const previousExactIdentities = Array.isArray(state?.exactProviderUserIdentities)
      ? state.exactProviderUserIdentities.map(value => String(value || ''))
      : [];
    const currentExactIdentities = turns.map(turn => String(turn?.identity || '').trim());
    const providerUserLedger = Array.isArray(state?.exactProviderUserMessages)
      ? state.exactProviderUserMessages.map(entry => ({
          role: 'user',
          key: String(entry?.key || ''),
          text: String(entry?.text || ''),
          lineTags: Array.isArray(entry?.lineTags) ? entry.lineTags.map(tag => String(tag || '').toUpperCase()) : [],
          identitySource: String(entry?.identitySource || ''),
          identityStable: entry?.identityStable === true,
          presentationKind: String(entry?.presentationKind || 'unknown-user-turn'),
          virtualized: entry?.virtualized === true,
          providerUserWorkAppDisplayText: String(entry?.providerUserWorkAppDisplayText || ''),
        })).filter(entry => entry.key)
      : [];
    const providerAccessibilityAliases = new Set(
      Array.isArray(state?.providerUserAccessibilityAliasIdentities)
        ? state.providerUserAccessibilityAliasIdentities.map(value => String(value || '')).filter(Boolean)
        : [],
    );
    const providerAccessibilityAliasMap = new Map(
      Array.isArray(state?.providerUserAccessibilityAliasMap)
        ? state.providerUserAccessibilityAliasMap
            .map(entry => [String(entry?.identity || ''), String(entry?.providerKey || '')])
            .filter(([identity, providerKey]) => identity && providerKey)
        : [],
    );
    const pendingAdmissionPrompt = String(ownedSession?.pendingAdmissionPrompt || '');
    const pendingAdmissionWorkAppDisplayText = String(ownedSession?.pendingAdmissionWorkAppDisplayText || '');
    const mayReconcileOwnedWindow = !!ownedSession && providerUserLedger.length > 0;
    if (mayReconcileOwnedWindow) {
      let orderedMessages = Array.isArray(observation.messages) ? observation.messages : [];
      const aliasIdentities = new Set(
        Array.isArray(state?.workContextAliasIdentities)
          ? state.workContextAliasIdentities.map(value => String(value || '')).filter(Boolean)
          : [],
      );
      const exactAliasIdentities = new Set(
        Array.isArray(state?.workContextExactIdentities)
          ? state.workContextExactIdentities.map(value => String(value || '')).filter(Boolean)
          : [],
      );
      const workContextAccessibilityAliasMap = new Map(
        Array.isArray(state?.workContextAccessibilityAliasMap)
          ? state.workContextAccessibilityAliasMap
              .map(entry => [
                String(entry?.identity || ''),
                {
                  exactKey: String(entry?.exactKey || ''),
                  text: String(entry?.text || ''),
                },
              ])
              .filter(([identity, binding]) => identity && binding.exactKey)
          : [],
      );
      const learningBoundary = activeTurn?.state === 'running'
        && observation.streaming === true
        && !!observation.stopButtonRef
        && !observation.sendButtonRef;
      const rebindLedgerKeys = new Set(providerUserLedger.map(entry => entry.key));
      if (learningBoundary) {
        const ledgerKeys = new Set(providerUserLedger.map(entry => entry.key));
        for (const entry of exactMessages) {
          if (ledgerKeys.has(entry.key) || exactAliasIdentities.has(entry.key)) continue;
          const matchesPending = pendingAdmissionPrompt
            && String(reconcileExpectedProviderUserMessage(entry, pendingAdmissionPrompt, pendingAdmissionWorkAppDisplayText)?.text || '') === pendingAdmissionPrompt;
          if (matchesPending) continue;
          if (entry.identityStable !== true || entry.presentationKind !== 'work-context-turn') {
            throw new Error('ChatGPT Work produced an untrusted exact user-shaped occurrence at the context-learning boundary.');
          }
          exactAliasIdentities.add(entry.key);
        }
      }
      const accessibilityUsersInOrder = orderedMessages
        .map(entry => normalizeOrderedMessage(entry))
        .filter(value => value?.role === 'user');
      if (accessibilityUsersInOrder.length === exactMessages.length) {
        for (let index = 0; index < exactMessages.length; index += 1) {
          const exact = exactMessages[index];
          const accessibility = accessibilityUsersInOrder[index];
          const accessibilityIdentity = orderedMessageIdentity(accessibility);
          const exactPending = pendingAdmissionPrompt
            && String(reconcileExpectedProviderUserMessage(exact, pendingAdmissionPrompt, pendingAdmissionWorkAppDisplayText)?.text || '') === pendingAdmissionPrompt;
          if (rebindLedgerKeys.has(exact.key) || exactPending) {
            providerAccessibilityAliases.add(accessibilityIdentity);
            providerAccessibilityAliasMap.set(accessibilityIdentity, exact.key);
            continue;
          }
          if (exactAliasIdentities.has(exact.key)) {
            const existingBinding = workContextAccessibilityAliasMap.get(accessibilityIdentity);
            if (existingBinding
              && (existingBinding.exactKey !== exact.key || existingBinding.text !== exact.text)) {
              throw new Error('ChatGPT Work context accessibility identity was recycled with different structural content.');
            }
            aliasIdentities.add(accessibilityIdentity);
            workContextAccessibilityAliasMap.set(accessibilityIdentity, {
              exactKey: exact.key,
              text: exact.text,
            });
          }
        }
      }
      if (aliasIdentities.size > 80 || exactAliasIdentities.size > 80) {
        throw new Error('ChatGPT Work context alias window exceeded the bounded user-occurrence count.');
      }
      const ledgerKeys = new Set(providerUserLedger.map(entry => entry.key));
      const unexpectedAccessibilityUsers = [];
      for (const entry of orderedMessages) {
        const value = normalizeOrderedMessage(entry);
        if (!value || value.role !== 'user') continue;
        const identity = orderedMessageIdentity(value);
        if (ledgerKeys.has(value.key) || providerAccessibilityAliases.has(identity)) continue;
        if (aliasIdentities.has(identity)) {
          const binding = workContextAccessibilityAliasMap.get(identity);
          if (binding && binding.text === value.text) continue;
          unexpectedAccessibilityUsers.push(value);
          continue;
        }
        const matchesAdmitted = providerUserLedger.some(admitted => {
          const reconciled = reconcileExpectedProviderUserMessage(value, admitted.text, admitted.providerUserWorkAppDisplayText);
          return String(reconciled?.text || '') === admitted.text;
        });
        const matchesPending = pendingAdmissionPrompt
          && String(reconcileExpectedProviderUserMessage(value, pendingAdmissionPrompt, pendingAdmissionWorkAppDisplayText)?.text || '') === pendingAdmissionPrompt;
        if (!matchesAdmitted && !matchesPending) unexpectedAccessibilityUsers.push(value);
      }
      if (unexpectedAccessibilityUsers.length > 0) {
        throw new Error('ChatGPT Work produced an untrusted user-shaped occurrence outside the admitted provider-user ledger.');
      }
      const pendingExactMessages = [];
      const unexpectedExactUsers = exactMessages.filter(entry => {
        if (ledgerKeys.has(entry.key) || exactAliasIdentities.has(entry.key)) return false;
        const matchesPending = pendingAdmissionPrompt
          && String(reconcileExpectedProviderUserMessage(entry, pendingAdmissionPrompt, pendingAdmissionWorkAppDisplayText)?.text || '') === pendingAdmissionPrompt;
        if (matchesPending) {
          pendingExactMessages.push(reconcileExpectedProviderUserMessage(entry, pendingAdmissionPrompt, pendingAdmissionWorkAppDisplayText));
          return false;
        }
        return true;
      });
      if (unexpectedExactUsers.length > 0) {
        throw new Error('ChatGPT exact provider-user window contains an untrusted structurally unknown occurrence outside the admitted Work aliases.');
      }
      const nextProviderLedger = [...providerUserLedger];
      for (const entry of pendingExactMessages) {
        if (!nextProviderLedger.some(existing => existing.key === entry.key)) nextProviderLedger.push({ ...entry });
      }
      if (nextProviderLedger.length > 80) throw new Error('ChatGPT admitted provider-user ledger exceeded the bounded turn count.');
      const placedLedgerKeys = new Set();
      let ledgerCursor = 0;
      const projectedOrderedMessages = [];
      for (const entry of orderedMessages) {
        const value = normalizeOrderedMessage(entry);
        if (!value || value.role !== 'user') {
          projectedOrderedMessages.push(entry);
          continue;
        }
        const accessibilityIdentity = orderedMessageIdentity(value);
        if (aliasIdentities.has(accessibilityIdentity)) continue;
        const mappedProviderKey = providerAccessibilityAliasMap.get(accessibilityIdentity);
        if (mappedProviderKey) {
          const mapped = nextProviderLedger.find(provider => provider.key === mappedProviderKey);
          if (!mapped) throw new Error('ChatGPT accessibility provider-user alias points outside the admitted exact ledger.');
          if (!placedLedgerKeys.has(mapped.key)) projectedOrderedMessages.push(mapped);
          placedLedgerKeys.add(mapped.key);
          const mappedIndex = nextProviderLedger.findIndex(provider => provider.key === mapped.key);
          if (mappedIndex >= ledgerCursor) ledgerCursor = mappedIndex + 1;
          continue;
        }
        const exactByKey = nextProviderLedger.find(provider => provider.key === value.key);
        if (exactByKey) {
          if (!placedLedgerKeys.has(exactByKey.key)) projectedOrderedMessages.push(exactByKey);
          placedLedgerKeys.add(exactByKey.key);
          const exactIndex = nextProviderLedger.findIndex(provider => provider.key === exactByKey.key);
          if (exactIndex >= ledgerCursor) ledgerCursor = exactIndex + 1;
          continue;
        }
        let matchedIndex = -1;
        for (let index = ledgerCursor; index < nextProviderLedger.length; index += 1) {
          const admitted = nextProviderLedger[index];
          const reconciled = reconcileExpectedProviderUserMessage(value, admitted.text);
          if (String(reconciled?.text || '') === admitted.text) {
            matchedIndex = index;
            break;
          }
        }
        if (matchedIndex < 0) {
          for (let index = 0; index < ledgerCursor; index += 1) {
            if (placedLedgerKeys.has(nextProviderLedger[index].key)) continue;
            const admitted = nextProviderLedger[index];
            const reconciled = reconcileExpectedProviderUserMessage(value, admitted.text);
            if (String(reconciled?.text || '') === admitted.text) {
              matchedIndex = index;
              break;
            }
          }
        }
        if (matchedIndex < 0) {
          throw new Error('ChatGPT accessibility provider-user occurrence could not be projected onto the admitted exact ledger.');
        }
        const admitted = nextProviderLedger[matchedIndex];
        if (!placedLedgerKeys.has(admitted.key)) projectedOrderedMessages.push(admitted);
        placedLedgerKeys.add(admitted.key);
        providerAccessibilityAliases.add(accessibilityIdentity);
        providerAccessibilityAliasMap.set(accessibilityIdentity, admitted.key);
        if (matchedIndex >= ledgerCursor) ledgerCursor = matchedIndex + 1;
      }
      const missingLedger = nextProviderLedger.filter(entry => !placedLedgerKeys.has(entry.key));
      orderedMessages = missingLedger.length > 0 ? [...missingLedger, ...projectedOrderedMessages] : projectedOrderedMessages;
      observation.providerUserObservation = aliasIdentities.size > 0 || exactAliasIdentities.size > 0
        ? 'fixed-read-only-work-context-window'
        : 'fixed-read-only-owned-provider-ledger-window';
      const coherentWindow = coherentMessageState(orderedMessages);
      const ledgerByKey = new Map(nextProviderLedger.map(entry => [entry.key, entry]));
      const projectedMessages = coherentWindow.messages.map(entry => (
        entry?.role === 'user' && ledgerByKey.has(entry.key)
          ? ledgerByKey.get(entry.key)
          : entry
      ));
      observation.messages = projectedMessages;
      observation.userMessages = projectedMessages.filter(entry => entry?.role === 'user').slice(-80);
      observation.assistantMessages = projectedMessages.filter(entry => entry?.role === 'assistant').slice(-80);
      observation.userTexts = observation.userMessages.map(entry => entry.text);
      observation.assistantTexts = observation.assistantMessages.map(entry => entry.text);
      if (state) {
        Object.assign(state, coherentMessageState(projectedMessages));
        state.exactProviderUserIdentities = nextProviderLedger.map(entry => entry.key.replace(/^fixed-provider-user:/, ''));
        state.exactProviderUserMessages = nextProviderLedger;
        state.providerUserAccessibilityAliasIdentities = [...providerAccessibilityAliases];
        state.providerUserAccessibilityAliasMap = [...providerAccessibilityAliasMap.entries()].map(([identity, providerKey]) => ({ identity, providerKey }));
        state.workContextAliasIdentities = [...aliasIdentities];
        state.workContextExactIdentities = [...exactAliasIdentities];
        state.workContextAccessibilityAliasMap = [...workContextAccessibilityAliasMap.entries()].map(([identity, binding]) => ({
          identity,
          exactKey: binding.exactKey,
          text: binding.text,
        }));
        state.workContextMode = aliasIdentities.size > 0 || exactAliasIdentities.size > 0 || state.workContextMode === true;
        state.deltaAppendedMessageIdentities = [];
      }
      return observation;
    }
    if (currentExactIdentities.length < previousExactIdentities.length
      || previousExactIdentities.some((identity, index) => currentExactIdentities[index] !== identity)) {
      throw new Error('ChatGPT fixed provider-user occurrence identity lineage changed.');
    }

    let orderedMessages = Array.isArray(observation.messages) ? observation.messages : [];
    let snapshotUsers = Array.isArray(observation.userMessages) ? observation.userMessages : [];
    let snapshotMessageUserCount = orderedMessages.filter(entry => entry?.role === 'user').length;
    if (snapshotUsers.length !== snapshotMessageUserCount) {
      throw new Error('ChatGPT accessibility user-message projections are internally incoherent.');
    }
    if (snapshotMessageUserCount !== exactMessages.length && observation.snapshotKind === 'delta') {
      const appendedIdentities = Array.isArray(state?.deltaAppendedMessageIdentities)
        ? state.deltaAppendedMessageIdentities.map(value => String(value || ''))
        : [];
      const appendedUserIdentities = appendedIdentities.filter(identity => identity.startsWith('user\u0000'));
      const newExactUserCount = currentExactIdentities.length - previousExactIdentities.length;
      if (appendedUserIdentities.length >= newExactUserCount) {
        const aliasCount = appendedUserIdentities.length - newExactUserCount;
        if (snapshotMessageUserCount - aliasCount === exactMessages.length) {
          const retainedNewUserIdentities = new Set(
            newExactUserCount > 0 ? appendedUserIdentities.slice(-newExactUserCount) : [],
          );
          const aliasIdentities = new Set(
            appendedUserIdentities.filter(identity => !retainedNewUserIdentities.has(identity)),
          );
          orderedMessages = orderedMessages.filter(entry => {
            const value = normalizeOrderedMessage(entry);
            return !value || !aliasIdentities.has(orderedMessageIdentity(value));
          });
          snapshotUsers = orderedMessages.filter(entry => entry?.role === 'user');
          snapshotMessageUserCount = snapshotUsers.length;
        }
      }
    }
    if (snapshotUsers.length !== exactMessages.length || snapshotMessageUserCount !== exactMessages.length) {
      const error = new Error(`ChatGPT fixed provider-user observation disagrees with the accessibility role occurrence count (snapshot=${snapshotMessageUserCount}, exact=${exactMessages.length}, kind=${observation.snapshotKind}).`);
      error.code = 'CHATGPT_PROVIDER_USER_COUNT_MISMATCH';
      throw error;
    }
    let userIndex = 0;
    observation.userMessages = exactMessages;
    observation.userTexts = exactMessages.map(entry => entry.text);
    observation.messages = orderedMessages.map(entry => {
      if (entry?.role !== 'user') return entry;
      return exactMessages[userIndex++];
    });
    observation.providerUserObservation = 'fixed-read-only';
    if (state) {
      Object.assign(state, coherentMessageState(observation.messages));
      state.exactProviderUserIdentities = currentExactIdentities;
      state.exactProviderUserMessages = exactMessages.map(entry => ({ ...entry }));
      state.providerUserAccessibilityAliasIdentities = snapshotUsers
        .map(entry => normalizeOrderedMessage(entry))
        .filter(Boolean)
        .map(entry => orderedMessageIdentity(entry));
      state.providerUserAccessibilityAliasMap = snapshotUsers
        .map((entry, index) => {
          const value = normalizeOrderedMessage(entry);
          const providerKey = exactMessages[index]?.key || '';
          return value && providerKey ? { identity: orderedMessageIdentity(value), providerKey } : null;
        })
        .filter(Boolean);
      state.workContextAliasIdentities = [];
      state.workContextAccessibilityAliasMap = [];
      state.workContextMode = false;
      state.deltaAppendedMessageIdentities = [];
    }
    return observation;
  }

  function normalizeOrderedMessage(entry) {
    const role = entry?.role === 'user' || entry?.role === 'assistant' ? entry.role : '';
    const key = String(entry?.key || '');
    if (!role || !key) return null;
    return { role, key, text: String(entry?.text || '') };
  }

  function orderedMessageIdentity(entry) {
    return `${entry.role}\u0000${entry.key}`;
  }

  function mergeOrderedMessages(previous = [], current = []) {
    const ordered = [];
    const byIdentity = new Map();
    const appendedIdentities = [];
    for (const entry of previous) {
      const value = normalizeOrderedMessage(entry);
      if (!value) continue;
      const identity = orderedMessageIdentity(value);
      if (!byIdentity.has(identity)) ordered.push(identity);
      byIdentity.set(identity, value);
    }
    for (const entry of current) {
      const value = normalizeOrderedMessage(entry);
      if (!value) continue;
      const identity = orderedMessageIdentity(value);
      if (!byIdentity.has(identity)) {
        ordered.push(identity);
        appendedIdentities.push(identity);
      }
      byIdentity.set(identity, value);
    }
    return {
      messages: ordered.map(identity => byIdentity.get(identity)).filter(Boolean).slice(-160),
      appendedIdentities,
    };
  }

  function coherentMessageState(messages = []) {
    const orderedMessages = messages
      .map(normalizeOrderedMessage)
      .filter(Boolean)
      .slice(-160);
    const userMessages = orderedMessages.filter(entry => entry.role === 'user').slice(-80);
    const assistantMessages = orderedMessages.filter(entry => entry.role === 'assistant').slice(-80);
    return {
      messages: orderedMessages,
      userMessages,
      assistantMessages,
      userTexts: userMessages.map(entry => entry.text),
      assistantTexts: assistantMessages.map(entry => entry.text),
    };
  }

  function mergePageState(page, parsed) {
    const pageId = String(page?.pageId || '');
    const previous = pageStates.get(pageId);
    const kind = String(parsed?.snapshotKind || 'full');
    let next;
    if (!previous || kind === 'full') {
      const preserveOwnedProviderHistory = !!previous && pageIsOwned(pageId);
      next = {
        ...parsed,
        ...coherentMessageState(parsed.messages),
        exactProviderUserIdentities: preserveOwnedProviderHistory
          ? (previous.exactProviderUserIdentities || [])
          : [],
        exactProviderUserMessages: preserveOwnedProviderHistory
          ? (previous.exactProviderUserMessages || [])
          : [],
        providerUserAccessibilityAliasIdentities: preserveOwnedProviderHistory
          ? (previous.providerUserAccessibilityAliasIdentities || [])
          : [],
        providerUserAccessibilityAliasMap: preserveOwnedProviderHistory
          ? (previous.providerUserAccessibilityAliasMap || [])
          : [],
        workContextAliasIdentities: preserveOwnedProviderHistory
          ? (previous.workContextAliasIdentities || [])
          : [],
        workContextExactIdentities: preserveOwnedProviderHistory
          ? (previous.workContextExactIdentities || [])
          : [],
        workContextAccessibilityAliasMap: preserveOwnedProviderHistory
          ? (previous.workContextAccessibilityAliasMap || [])
          : [],
        workContextMode: preserveOwnedProviderHistory && previous.workContextMode === true,
        deltaAppendedMessageIdentities: [],
      };
    } else if (kind === 'none' || kind === 'unchanged') {
      next = {
        ...previous,
        ...coherentMessageState(previous.messages),
        href: parsed.href || previous.href,
        origin: parsed.origin || previous.origin,
        title: parsed.title || previous.title,
        snapshotKind: kind,
        deltaAppendedMessageIdentities: [],
      };
    } else {
      const mergedMessages = mergeOrderedMessages(previous.messages, parsed.messages);
      next = {
        ...previous,
        ...coherentMessageState(mergedMessages.messages),
        href: parsed.href || previous.href,
        origin: parsed.origin || previous.origin,
        title: parsed.title || previous.title,
        snapshotKind: kind,
        deltaAppendedMessageIdentities: mergedMessages.appendedIdentities,
      };
      if (parsed.composerObserved) {
        next.composerFound = parsed.composerFound;
        next.composerRef = parsed.composerRef;
        next.composerText = parsed.composerText;
        next.composerAmbiguous = parsed.composerAmbiguous;
        next.sendButtonRef = parsed.sendButtonRef;
        next.sendButtonAmbiguous = parsed.sendButtonAmbiguous;
      }
      if (parsed.streamingKnown) {
        next.streaming = parsed.streaming;
        next.stopButtonRef = parsed.stopButtonRef;
      }
      if (parsed.responseCompleteKnown) {
        next.responseComplete = parsed.responseComplete;
      }
    }
    pageStates.set(pageId, next);
    return next;
  }

  function pageIsOwned(pageId) {
    const exact = String(pageId || '').trim();
    if (!exact) return false;
    return [...sessions.values()].some(session => session.pageId === exact);
  }

  async function sharedPages() {
    const listed = await invokeBrowserTool('list_browser_pages', {});
    return workerPageResources.parseSharedBrowserPages(resultText(listed));
  }

  async function observe(page) {
    const result = await invokeBrowserTool('read_page', { pageId: page.pageId });
    const observation = observeResult(page, result);
    if (typeof observeExactComposer !== 'function') throw new Error('ChatGPT exact composer observation is unavailable.');
    const exactComposer = await observeExactComposer({ pageId: page.pageId, url: observation.href || page.url });
    if (!exactComposer || typeof exactComposer !== 'object') throw new Error('ChatGPT exact composer observation returned no structured result.');
    if (String(exactComposer.href || '') !== String(observation.href || '')) {
      throw new Error(`ChatGPT exact composer observation page lineage changed: ${String(exactComposer.href || '')}`);
    }
    const composerFound = observation.composerFound && exactComposer.composerFound === true;
    const composerAmbiguous = observation.composerAmbiguous || exactComposer.composerAmbiguous === true;
    observation.composerFound = composerFound;
    observation.composerText = composerAmbiguous ? '' : String(exactComposer.composerText ?? '');
    observation.composerLineTags = composerAmbiguous || !Array.isArray(exactComposer.composerLineTags)
      ? []
      : exactComposer.composerLineTags.map(value => String(value || '').toUpperCase());
    observation.composerDecorations = composerAmbiguous || !Array.isArray(exactComposer.composerDecorations)
      ? []
      : exactComposer.composerDecorations.map(value => ({
          kind: String(value?.kind || ''),
          tagName: String(value?.tagName || ''),
          name: String(value?.name || ''),
          path: String(value?.path || ''),
          href: String(value?.href || ''),
          label: String(value?.label || ''),
        }));
    observation.composerDecorationFingerprint = composerAmbiguous
      ? ''
      : String(exactComposer.composerDecorationFingerprint || JSON.stringify(observation.composerDecorations));
    observation.rawComposerText = composerAmbiguous ? '' : String(exactComposer.rawComposerText ?? exactComposer.composerText ?? '');
    observation.composerAmbiguous = composerAmbiguous;
    observation.ready = observation.ready && composerFound && !composerAmbiguous;
    if (typeof observeExactProviderUsers !== 'function') throw new Error('ChatGPT exact provider-user observation is unavailable.');
    const exactProviderUsers = await observeExactProviderUsers({ pageId: page.pageId, url: observation.href || page.url });
    applyExactProviderUserObservation(observation, exactProviderUsers);
    const state = pageStates.get(String(page.pageId || ''));
    if (state) {
      state.composerFound = composerFound;
      state.composerText = observation.composerText;
      state.composerAmbiguous = composerAmbiguous;
    }
    return observation;
  }

  function observeResult(page, result) {
    const parsed = chatGptResources.parseReadPageResult(page, resultText(result));
    const merged = mergePageState(page, parsed);
    const normalized = chatGptResources.normalizeObservation(page, merged);
    normalized.snapshotKind = parsed.snapshotKind;
    normalized.changeMessages = parsed.snapshotKind === 'delta'
      ? (parsed.messages || []).map(entry => ({ role: entry.role, key: String(entry.key || ''), text: String(entry.text || '') }))
      : [];
    return normalized;
  }

  async function findObservation(pageId) {
    const page = (await sharedPages()).find(item => item.pageId === pageId);
    if (!page) return undefined;
    return await observe(page);
  }

  async function listResources() {
    const resources = [];
    for (const page of await sharedPages()) {
      if (pageIsOwned(page.pageId)) continue;
      if (!chatGptResources.CHATGPT_HOSTS.has((() => {
        try { return new URL(page.url).hostname.toLowerCase(); } catch { return ''; }
      })())) continue;
      try {
        resources.push(await observe(page));
      } catch {
        // A disappearing/shared page is simply not an assignment candidate.
      }
    }
    return resources;
  }

  async function probeResource(pageId) {
    const exactPageId = String(pageId || '').trim();
    if (!exactPageId) throw new Error('ChatGPT worker resource probe requires pageId.');
    if (pageIsOwned(exactPageId)) return undefined;
    return await findObservation(exactPageId);
  }

  async function connect(options = {}) {
    const target = options.target || (options.extensions && options.extensions.chatGptTarget);
    if (!target) throw new Error('ChatGPT worker connect requires an exact assignment target.');
    const targetPageId = String(target.pageId || '').trim();
    if (pageIsOwned(targetPageId)) throw new Error('ChatGPT exact page is already owned by another WorkerSession: ' + targetPageId);
    const observation = await findObservation(targetPageId);
    chatGptResources.assertExactTarget(target, observation);
    const sessionId = observation.lifecycleIdentity;
    if (sessions.has(sessionId)) throw new Error('ChatGPT exact page generation is already connected: ' + sessionId);
    sessions.set(sessionId, {
      sessionId,
      pageId: observation.pageId,
      origin: observation.origin,
      href: observation.href,
      conversationId: observation.conversationId || '',
      resourceIdentity: observation.resourceIdentity,
      lifecycleIdentity: observation.lifecycleIdentity,
      activeTurn: null,
    });
    return {
      pageId: observation.pageId,
      sessionId,
      site: 'chatgpt',
      origin: observation.origin,
      href: observation.href,
      conversationId: observation.conversationId,
      transport: 'integrated-browser-playwright',
    };
  }

  function requireSession(pageId, sessionId) {
    const session = sessions.get(String(sessionId || ''));
    if (!session) throw new Error('Unknown ChatGPT worker session: ' + String(sessionId || ''));
    if (session.pageId !== String(pageId || '')) throw new Error('ChatGPT worker page identity mismatch for session ' + session.sessionId);
    return session;
  }

  function appendEvent(turn, type, payload = {}) {
    turn.events.push({ seq: turn.nextEventSeq++, type, ...payload });
    if (turn.events.length > 160) turn.events.splice(0, turn.events.length - 160);
  }

  function snapshot(turn) {
    return {
      inputId: turn.inputId,
      state: turn.state,
      text: turn.text,
      error: turn.error || null,
      events: turn.events.map(event => ({ ...event })),
    };
  }

  function assertObservationPageGeneration(session, observation) {
    if (!observation || observation.pageId !== session.pageId || observation.origin !== session.origin) {
      throw new Error('ChatGPT exact page origin/generation changed.');
    }
  }

  function assertObservationLineage(session, observation, allowConversationCreation, turn) {
    assertObservationPageGeneration(session, observation);
    if (session.conversationId) {
      if (observation.conversationId !== session.conversationId) {
        throw new Error('ChatGPT provider conversation lineage changed.');
      }
      session.href = observation.href;
      return;
    }
    if (observation.conversationId && allowConversationCreation) {
      if (!turn) throw new Error('ChatGPT conversation creation requires the exact active turn.');
      if (turn.provisionalConversationId && turn.provisionalConversationId !== observation.conversationId) {
        throw new Error('ChatGPT provider conversation lineage changed after first-turn admission.');
      }
      turn.provisionalConversationId = observation.conversationId;
      turn.provisionalHref = observation.href;
      return;
    }
    if (observation.href !== session.href) {
      throw new Error('ChatGPT pre-conversation page changed outside the admitted send transition.');
    }
  }

  function responseText(turn, observation) {
    const messages = Array.isArray(observation.messages) ? observation.messages : [];
    let userIndex = -1;
    if (turn.submittedUserKey) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user' && messages[index]?.key === turn.submittedUserKey) {
          userIndex = index;
          break;
        }
      }
    }
    if (userIndex < 0) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') {
          userIndex = index;
          break;
        }
      }
    }
    if (userIndex < 0) return '';
    const user = reconcileExpectedProviderUserMessage(messages[userIndex], turn.prompt, turn.providerUserWorkAppDisplayText);
    if (String(user?.text || '') !== turn.prompt) {
      throw new Error('ChatGPT latest provider user turn no longer matches the admitted Worker prompt.');
    }
    for (let index = userIndex + 1; index < messages.length; index += 1) {
      if (messages[index]?.role === 'assistant') return String(messages[index].text || '').trim();
    }
    return '';
  }

  function admittedUserMessage(observation, baselineUserKeys, prompt, workAppDisplayText = '') {
    const stableNew = (observation.userMessages || [])
      .filter(entry => entry?.key && !baselineUserKeys.has(entry.key));
    if (stableNew.length > 1) {
      throw new Error('ChatGPT submission produced multiple new provider user identities; admission is ambiguous.');
    }
    if (stableNew.length === 1) {
      const exact = reconcileExpectedProviderUserMessage(stableNew[0], prompt, workAppDisplayText);
      if (exact.text !== prompt) {
        throw new Error('ChatGPT page accepted unexpected user text instead of the admitted Worker prompt.');
      }
      return exact;
    }
    const changedUsers = (observation.changeMessages || []).filter(entry => entry?.role === 'user' && entry.text);
    if (changedUsers.some(entry => entry.text !== prompt)) {
      throw new Error('ChatGPT mutation delta contains unexpected user text; admission is ambiguous.');
    }
    if (changedUsers.length > 1) {
      throw new Error('ChatGPT mutation delta contains multiple user turns; admission is ambiguous.');
    }
    return changedUsers.length === 1 ? changedUsers[0] : undefined;
  }

  async function refreshTurn(session, turn) {
    if (turn.state !== 'running') return turn;
    const observation = await findObservation(session.pageId);
    assertObservationLineage(session, observation, true, turn);
    const nextText = responseText(turn, observation);
    const currentNow = now();
    if (nextText !== turn.text) {
      const previous = turn.text;
      turn.text = nextText;
      turn.lastChangeAt = currentNow;
      const delta = nextText.startsWith(previous) ? nextText.slice(previous.length) : nextText;
      if (delta) appendEvent(turn, 'assistant_text', { text: delta, reset: !!previous && !nextText.startsWith(previous) });
    }
    if (!observation.responseComplete) turn.terminalResetObserved = true;
    if (turn.terminalResetObserved
      && turn.text
      && observation.responseComplete
      && !observation.streaming
      && currentNow - turn.lastChangeAt >= 1600) {
      if (!session.conversationId && turn.provisionalConversationId) {
        session.conversationId = turn.provisionalConversationId;
        session.href = turn.provisionalHref || observation.href;
      }
      turn.state = 'completed';
      appendEvent(turn, 'completed', { text: turn.text });
    }
    return turn;
  }

  async function send(session, input) {
    const inputId = String(input && input.inputId || '').trim();
    const prompt = String(input && input.prompt || '');
    if (!inputId || !prompt.trim()) throw new Error('ChatGPT worker send requires inputId and prompt.');
    if (session.activeTurn
      && session.activeTurn.inputId === inputId
      && session.activeTurn.prompt === prompt) {
      if (session.activeTurn.state === 'running') await refreshTurn(session, session.activeTurn);
      return snapshot(session.activeTurn);
    }
    if (session.activeTurn && session.activeTurn.state === 'running') throw new Error('ChatGPT worker turn is already running: ' + session.activeTurn.inputId);
    if (input && input.recoverExisting === true) {
      const recoveryWorkAppDisplayText = String(input.workAppDisplayText || '').trim();
      if (!recoveryWorkAppDisplayText
        || recoveryWorkAppDisplayText.length > 240
        || recoveryWorkAppDisplayText.includes('\n')
        || recoveryWorkAppDisplayText.includes('\r')) {
        throw new Error('ChatGPT existing-submission recovery requires the exact bounded Work app display text.');
      }
      const observation = await findObservation(session.pageId);
      assertObservationPageGeneration(session, observation);
      if (!observation.conversationId) {
        throw new Error('ChatGPT existing-submission recovery requires an already-created provider conversation.');
      }
      if (session.conversationId && session.conversationId !== observation.conversationId) {
        throw new Error('ChatGPT existing-submission recovery conversation lineage does not match the connected session.');
      }
      const stableUsers = (observation.userMessages || []).filter(entry => entry?.key);
      if (stableUsers.length !== 1) {
        throw new Error('ChatGPT existing-submission recovery requires exactly one stable provider user identity.');
      }
      const submittedUser = reconcileExpectedProviderUserMessage(stableUsers[0], prompt, recoveryWorkAppDisplayText);
      if (String(submittedUser?.text || '') !== prompt) {
        throw new Error('ChatGPT existing-submission recovery user text does not match the exact admitted Worker prompt.');
      }
      const admittedState = pageStates.get(session.pageId);
      if (admittedState) {
        const currentLedger = Array.isArray(admittedState.exactProviderUserMessages)
          ? admittedState.exactProviderUserMessages.map(entry => ({ ...entry }))
          : [];
        const ledgerIndex = currentLedger.findIndex(entry => entry?.key === submittedUser.key);
        if (ledgerIndex >= 0) currentLedger[ledgerIndex] = { ...currentLedger[ledgerIndex], ...submittedUser };
        else currentLedger.push({ ...submittedUser });
        admittedState.exactProviderUserMessages = currentLedger.slice(-80);
        const reconciledMessages = (Array.isArray(admittedState.messages) ? admittedState.messages : []).map(entry => (
          entry?.role === 'user' && entry?.key === submittedUser.key ? { ...entry, ...submittedUser } : entry
        ));
        Object.assign(admittedState, coherentMessageState(reconciledMessages));
        pageStates.set(session.pageId, admittedState);
      }
      session.conversationId = observation.conversationId;
      session.href = observation.href;
      const startedAt = now();
      const turn = {
        inputId,
        prompt,
        state: 'running',
        text: '',
        error: '',
        submittedUserKey: submittedUser.key || '',
        providerUserWorkAppDisplayText: recoveryWorkAppDisplayText,
        startedAt,
        lastChangeAt: startedAt,
        nextEventSeq: 1,
        events: [],
        provisionalConversationId: observation.conversationId,
        provisionalHref: observation.href,
        terminalResetObserved: true,
      };
      appendEvent(turn, 'status', { name: 'recovered-existing-submission' });
      session.activeTurn = turn;
      await refreshTurn(session, turn);
      return snapshot(turn);
    }
    if (typeof ensureExactPageVisible !== 'function') throw new Error('ChatGPT exact-page visibility authority is unavailable.');
    const page = await ensureExactPageVisible({
      pageId: session.pageId,
      expectedUrl: session.href,
      expectedOrigin: session.origin,
      label: 'ChatGPT worker send page',
    });
    const before = await findObservation(session.pageId);
    assertObservationLineage(session, before, false);
    if (!before.composerRef) throw new Error('ChatGPT composer is unavailable');
    if (before.composerAmbiguous) throw new Error('ChatGPT composer observation is ambiguous; worker refused to overwrite it');
    if (before.composerText) {
      throw new Error('ChatGPT composer contains user text; worker refused to overwrite it');
    }
    const beforeDecorationFingerprint = String(before.composerDecorationFingerprint || JSON.stringify(before.composerDecorations || []));
    const hasComposerDecorations = Array.isArray(before.composerDecorations) && before.composerDecorations.length > 0;
    const providerUserWorkAppDisplayText = hasComposerDecorations ? composerDecorationDisplayText(before) : '';
    let fillResult;
    if (hasComposerDecorations) {
      fillResult = await invokeBrowserTool('type_in_page', {
        pageId: session.pageId,
        ref: before.composerRef,
        element: 'ChatGPT composer',
        text: prompt,
        submit: false,
        literalText: true,
      });
    } else {
      fillResult = await invokeBrowserTool('type_in_page', {
        pageId: session.pageId,
        ref: before.composerRef,
        element: 'ChatGPT composer',
        text: prompt,
        submit: false,
      });
    }
    const afterFillDelta = observeResult(page, fillResult);
    assertObservationLineage(session, afterFillDelta, false);
    await new Promise(resolve => setTimeout(resolve, 120));
    const rawAfterFill = await findObservation(session.pageId);
    assertObservationLineage(session, rawAfterFill, false);
    const afterFill = reconcileExpectedComposerObservation(rawAfterFill, prompt);
    if (afterFill.composerAmbiguous || afterFill.composerText !== prompt) {
      throw new Error('ChatGPT composer did not stably contain the admitted Worker prompt after fill.');
    }
    const afterDecorationFingerprint = String(afterFill.composerDecorationFingerprint || JSON.stringify(afterFill.composerDecorations || []));
    if (afterDecorationFingerprint !== beforeDecorationFingerprint) {
      throw new Error('ChatGPT composer decoration identity changed during prompt entry; worker refused to submit.');
    }
    if (afterFill.sendButtonAmbiguous) {
      throw new Error('ChatGPT submit control is ambiguous; worker refused to guess a submit target.');
    }
    if (!afterFill.sendButtonRef) {
      throw new Error('ChatGPT exact submit control is unavailable; worker refused to submit.');
    }
    const baselineUserKeys = new Set((before.userMessages || []).map(entry => entry?.key).filter(Boolean));
    const provisional = { prompt, provisionalConversationId: '', provisionalHref: '' };
    const firstConversationTransition = !session.conversationId;
    const admitObservation = observation => {
      if (firstConversationTransition) {
        assertObservationPageGeneration(session, observation);
      } else {
        assertObservationLineage(session, observation, false);
      }
      const admitted = admittedUserMessage(observation, baselineUserKeys, prompt, providerUserWorkAppDisplayText);
      if (!admitted) return undefined;
      if (firstConversationTransition) {
        if (!observation.conversationId) return undefined;
        if (provisional.provisionalConversationId
          && provisional.provisionalConversationId !== observation.conversationId) {
          throw new Error('ChatGPT provider conversation lineage changed after first-turn admission.');
        }
        provisional.provisionalConversationId = observation.conversationId;
        provisional.provisionalHref = observation.href;
      }
      return admitted;
    };
    let submitGestureError;
    let submitResult;
    let sentObservation = null;
    let submittedUser;
    session.pendingAdmissionPrompt = prompt;
    session.pendingAdmissionWorkAppDisplayText = providerUserWorkAppDisplayText;
    try {
      try {
        submitResult = await invokeBrowserTool('click_element', {
          pageId: session.pageId,
          ref: afterFill.sendButtonRef,
          element: 'ChatGPT exact submit button',
        });
      } catch (error) {
        submitGestureError = error;
      }
      if (submitResult !== undefined) {
        const observedSubmitResult = observeResult(page, submitResult);
        if (firstConversationTransition) assertObservationPageGeneration(session, observedSubmitResult);
        else assertObservationLineage(session, observedSubmitResult, false);
      }
      for (let attempt = 0; attempt < 26; attempt += 1) {
        if (sentObservation) break;
        if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 200));
        let observation;
        try {
          observation = await findObservation(session.pageId);
        } catch (error) {
          // Accessibility and fixed DOM reads are sequential. During this
          // admission window only, let a count mismatch converge by observing
          // again; never repeat the submit gesture or relax exact admission.
          if (error?.code === 'CHATGPT_PROVIDER_USER_COUNT_MISMATCH' && attempt < 25) continue;
          throw error;
        }
        submittedUser = admitObservation(observation);
        if (submittedUser) {
          sentObservation = observation;
          break;
        }
      }
      if (!sentObservation) {
        const detail = submitGestureError instanceof Error ? ` Original submit gesture error: ${submitGestureError.message}` : '';
        throw new Error('ChatGPT message submission was not confirmed; worker will not issue a second submit gesture.' + detail);
      }
    } finally {
      session.pendingAdmissionPrompt = '';
      session.pendingAdmissionWorkAppDisplayText = '';
    }
    const admittedState = pageStates.get(session.pageId);
    if (admittedState && submittedUser?.key) {
      const currentLedger = Array.isArray(admittedState.exactProviderUserMessages)
        ? admittedState.exactProviderUserMessages.map(entry => ({ ...entry }))
        : [];
      const ledgerIndex = currentLedger.findIndex(entry => entry?.key === submittedUser.key);
      if (ledgerIndex >= 0) currentLedger[ledgerIndex] = { ...currentLedger[ledgerIndex], ...submittedUser };
      else currentLedger.push({ ...submittedUser });
      admittedState.exactProviderUserMessages = currentLedger.slice(-80);
      const reconciledMessages = (Array.isArray(admittedState.messages) ? admittedState.messages : []).map(entry => (
        entry?.role === 'user' && entry?.key === submittedUser.key ? { ...entry, ...submittedUser } : entry
      ));
      Object.assign(admittedState, coherentMessageState(reconciledMessages));
      pageStates.set(session.pageId, admittedState);
    }
    const startedAt = now();
    const turn = {
      inputId,
      prompt,
      state: 'running',
      text: '',
      error: '',
      submittedUserKey: submittedUser?.key || '',
      providerUserWorkAppDisplayText,
      startedAt,
      lastChangeAt: startedAt,
      nextEventSeq: 1,
      events: [],
      provisionalConversationId: sentObservation.conversationId || provisional.provisionalConversationId || '',
      provisionalHref: sentObservation.conversationId ? sentObservation.href : provisional.provisionalHref || '',
      terminalResetObserved: sentObservation.responseComplete !== true,
    };
    appendEvent(turn, 'status', { name: 'sent' });
    session.activeTurn = turn;
    return snapshot(turn);
  }

  async function interrupt(session, inputId) {
    const turn = session.activeTurn;
    if (!turn || turn.inputId !== String(inputId || '') || turn.state !== 'running') return { interrupted: false, turn: turn ? snapshot(turn) : null };
    const before = await findObservation(session.pageId);
    assertObservationLineage(session, before, true, turn);
    let interrupted = false;
    if (before.streaming && before.stopButtonRef) {
      const interruptResult = await invokeBrowserTool('click_element', {
        pageId: session.pageId,
        ref: before.stopButtonRef,
        element: 'ChatGPT stop generation button',
      });
      const page = { pageId: session.pageId, title: '', url: session.href, visible: true };
      const immediateAfter = observeResult(page, interruptResult);
      const after = immediateAfter.streamingKnown === false ? await findObservation(session.pageId) : immediateAfter;
      assertObservationLineage(session, after, true, turn);
      interrupted = after.streaming !== true;
    }
    turn.state = 'cancelled';
    appendEvent(turn, 'cancelled', { interrupted });
    return { interrupted, turn: snapshot(turn) };
  }

  async function control(request) {
    const session = requireSession(request && request.pageId, request && request.sessionId);
    const action = String(request && request.action || '').trim();
    if (action === 'send') return await send(session, request.input || {});
    if (action === 'poll') {
      if (!session.activeTurn || session.activeTurn.inputId !== String(request.inputId || '')) throw new Error('Unknown ChatGPT worker turn: ' + String(request.inputId || ''));
      await refreshTurn(session, session.activeTurn);
      return snapshot(session.activeTurn);
    }
    if (action === 'interrupt') return await interrupt(session, request.inputId);
    if (action === 'health') {
      const observation = await findObservation(session.pageId);
      assertObservationLineage(session, observation, session.activeTurn && session.activeTurn.state === 'running', session.activeTurn);
      return { session: { sessionId: session.sessionId, pageId: session.pageId, origin: session.origin, href: session.href, conversationId: session.conversationId || undefined }, observation };
    }
    if (action === 'disconnect') {
      if (session.activeTurn && session.activeTurn.state === 'running') await interrupt(session, session.activeTurn.inputId);
      sessions.delete(session.sessionId);
      return { disconnected: true, sessionId: session.sessionId };
    }
    throw new Error('Unsupported ChatGPT worker action: ' + action);
  }

  return { listResources, probeResource, connect, control, sessionCount: () => sessions.size };
}

module.exports = { createChatGptWorkerController };

(function createShunCodeWebMcpCore(options = {}) {
  const seen = new Set();
  const pendingDeliveries = new Map();
  const storage = options.storage || null;
  const seenStorageKey = String(options.seenStorageKey || '');

  function parseJsonObjectAt(text, startIndex) {
    const start = text.indexOf('{', startIndex);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const raw = text.slice(start, index + 1);
          try { return { value: JSON.parse(raw), endIndex: index + 1 }; }
          catch { return null; }
        }
      }
    }
    return null;
  }

  function parseToolJsonObject(text, markerIndex, markerLength) {
    const parsed = parseJsonObjectAt(text, markerIndex + markerLength);
    if (parsed) return parsed;
    const closeMarkerIndex = text.indexOf('[/SHUNCODE_TOOL]', markerIndex + markerLength);
    if (closeMarkerIndex < 0) return null;
    const start = text.indexOf('{', markerIndex + markerLength);
    if (start < 0 || start >= closeMarkerIndex) return null;
    const raw = text.slice(start, closeMarkerIndex).trim();
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      if (depth < 0) return null;
    }
    if (inString || depth < 1 || depth > 3) return null;
    try {
      return { value: JSON.parse(raw + '}'.repeat(depth)), endIndex: closeMarkerIndex, repairedTrailingBraces: depth };
    } catch {
      return null;
    }
  }

  function parseLineScalar(value) {
    const text = String(value ?? '').trim();
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null') return null;
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return Number(text);
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      try { return JSON.parse(text); } catch {}
    }
    return text;
  }

  function setLineArgument(target, dottedPath, value) {
    const parts = String(dottedPath || '').split('.').filter(Boolean);
    if (!parts.length) return;
    let current = target;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const key = /^\d+$/.test(part) ? Number(part) : part;
      if (index === parts.length - 1) {
        current[key] = value;
        return;
      }
      const nextIsArray = /^\d+$/.test(parts[index + 1]);
      if (!current[key] || typeof current[key] !== 'object') current[key] = nextIsArray ? [] : {};
      current = current[key];
    }
  }

  function parseToolLineObject(text, markerIndex, markerLength) {
    const closeMarker = '[/SHUNCODE_TOOL]';
    const closeMarkerIndex = text.indexOf(closeMarker, markerIndex + markerLength);
    if (closeMarkerIndex < 0) return null;
    const raw = text.slice(markerIndex + markerLength, closeMarkerIndex).trim();
    if (!raw || raw.startsWith('{')) return null;
    const lines = raw.split(/\r?\n/);
    const call = { arguments: {} };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      const heredoc = line.match(/^arg\.([A-Za-z0-9_.-]+)<<([A-Za-z0-9_-]+)$/);
      if (heredoc) {
        const [, dottedPath, terminator] = heredoc;
        const chunks = [];
        let closed = false;
        for (index += 1; index < lines.length; index += 1) {
          if (lines[index].trim() === terminator) {
            closed = true;
            break;
          }
          chunks.push(lines[index]);
        }
        if (!closed) return null;
        setLineArgument(call.arguments, dottedPath, chunks.join('\n'));
        continue;
      }
      const pair = line.match(/^(id|name|arg\.([A-Za-z0-9_.-]+))=(.*)$/);
      if (!pair) continue;
      if (pair[1] === 'id') call.id = pair[3].trim();
      else if (pair[1] === 'name') call.name = pair[3].trim();
      else setLineArgument(call.arguments, pair[2], parseLineScalar(pair[3]));
    }
    if (typeof call.name !== 'string' || !call.name) return null;
    return { value: call, endIndex: closeMarkerIndex + closeMarker.length, lineProtocol: true };
  }

  function parseToolObject(text, markerIndex, markerLength) {
    return parseToolJsonObject(text, markerIndex, markerLength)
      || parseToolLineObject(text, markerIndex, markerLength);
  }

  function extractCalls(text) {
    const calls = [];
    const markers = ['[SHUNCODE_TOOL]', '```SHUNCODE_TOOL'];
    for (const marker of markers) {
      let fromIndex = 0;
      while (fromIndex < text.length) {
        const markerIndex = text.indexOf(marker, fromIndex);
        if (markerIndex < 0) break;
        const parsed = parseToolObject(text, markerIndex, marker.length);
        fromIndex = parsed?.endIndex || markerIndex + marker.length;
        const call = parsed?.value;
        if (!call || typeof call.name !== 'string') continue;
        if (call.name === '__example__' || call.name === 'TOOL_NAME' || String(call.id || '').startsWith('example-')) continue;
        calls.push(call);
      }
    }
    return calls;
  }

  function extractCompletedCallCounts(text) {
    const counts = new Map();
    const marker = '[SHUNCODE_TOOL_RESULT]';
    let fromIndex = 0;
    while (fromIndex < text.length) {
      const markerIndex = text.indexOf(marker, fromIndex);
      if (markerIndex < 0) break;
      const parsed = parseJsonObjectAt(text, markerIndex + marker.length);
      fromIndex = parsed?.endIndex || markerIndex + marker.length;
      const id = parsed?.value?.id;
      if (id != null) {
        const key = String(id);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return counts;
  }

  function callBaseKey(call) {
    return String(call.id || `${call.name}:${JSON.stringify(call.arguments || {})}`);
  }

  function persistSeen() {
    if (!storage || !seenStorageKey) return;
    try { storage.setItem(seenStorageKey, JSON.stringify([...seen].slice(-200))); } catch {}
  }

  function rememberSeen(key) {
    seen.add(String(key));
    persistSeen();
  }

  function seedSeenFromHistory(occurrences, completedCounts) {
    for (const occurrence of occurrences) {
      if (occurrence.ordinal <= (completedCounts.get(occurrence.baseKey) || 0)) seen.add(occurrence.key);
    }
    if (storage && seenStorageKey) {
      try {
        const stored = JSON.parse(storage.getItem(seenStorageKey) || '[]');
        if (Array.isArray(stored)) {
          for (const rawKey of stored.map(String)) {
            if (rawKey.includes('::occurrence:')) {
              seen.add(rawKey);
              continue;
            }
            const legacyOccurrence = occurrences.find(item => item.baseKey === rawKey && !seen.has(item.key));
            if (legacyOccurrence) seen.add(legacyOccurrence.key);
          }
        }
      } catch {}
    }
  }

  return {
    parseJsonObjectAt,
    extractCalls,
    extractCompletedCallCounts,
    callBaseKey,
    hasSeen: key => seen.has(String(key)),
    rememberSeen,
    seedSeenFromHistory,
    seenCount: () => seen.size,
    getPendingDelivery: key => pendingDeliveries.get(String(key)),
    setPendingDelivery: (key, value) => pendingDeliveries.set(String(key), value),
    deletePendingDelivery: key => pendingDeliveries.delete(String(key)),
    pendingDeliveryEntries: () => [...pendingDeliveries.entries()],
    pendingDeliveryCount: () => pendingDeliveries.size,
  };
})

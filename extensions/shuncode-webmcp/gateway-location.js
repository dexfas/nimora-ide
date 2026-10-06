'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Gateway executable selection is independent of the opened user workspace.
 * The first location belongs to the installed extension. The second is an
 * explicit, structurally checked checkout-only development fallback.
 * Never run a server.mjs supplied by an arbitrary project or PATH lookup.
 */
function isTrustedGateway(candidate) {
  if (!fs.existsSync(path.join(candidate, 'server.mjs'))) return false;
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'));
    return metadata.name === 'shuncode-browser-mcp-gateway'
      && fs.existsSync(path.join(candidate, 'integrated-browser-provider.mjs'))
      && fs.existsSync(path.join(candidate, 'webmcp-page-host.mjs'));
  } catch {
    return false;
  }
}

function findExtensionGatewayDirectory(extensionDirectory) {
  const owned = path.resolve(extensionDirectory);
  const bundled = path.join(owned, 'gateway');
  if (isTrustedGateway(bundled)) return bundled;

  // This path only exists in an unbundled repository checkout. A released
  // extension must instead ship the extension-local staged gateway above.
  if (path.basename(owned) === 'shuncode-webmcp' && path.basename(path.dirname(owned)) === 'extensions') {
    const checkout = path.resolve(owned, '..', '..', 'tools', 'webmcp-gateway');
    if (isTrustedGateway(checkout)) return checkout;
  }
  return null;
}

module.exports = { findExtensionGatewayDirectory, isTrustedGateway };

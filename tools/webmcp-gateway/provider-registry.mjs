function assertProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new Error('Gateway provider must be an object.');
  if (typeof provider.id !== 'string' || !provider.id.trim()) throw new Error('Gateway provider id must not be empty.');
  if (typeof provider.listTools !== 'function') throw new Error(`Gateway provider ${provider.id} must implement listTools().`);
  if (typeof provider.callTool !== 'function') throw new Error(`Gateway provider ${provider.id} must implement callTool().`);
  if (provider.owns !== undefined && typeof provider.owns !== 'function') throw new Error(`Gateway provider ${provider.id} owns must be a function.`);
}

export function defineGatewayProvider(provider) {
  assertProvider(provider);
  return Object.freeze({ ...provider });
}

export class GatewayProviderRegistry {
  #providers = [];

  constructor(providers = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider) {
    assertProvider(provider);
    if (this.#providers.some(existing => existing.id === provider.id)) {
      throw new Error(`Gateway provider already registered: ${provider.id}`);
    }
    this.#providers.push(provider);
    return provider;
  }

  listProviders() {
    return this.#providers.map(provider => ({ id: provider.id, fallback: provider.fallback === true }));
  }

  async listTools({ filter } = {}) {
    const tools = [];
    for (const provider of this.#providers) {
      const listed = await provider.listTools();
      if (!Array.isArray(listed)) throw new Error(`Gateway provider ${provider.id} returned a non-array tool list.`);
      for (const tool of listed) {
        if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) {
          throw new Error(`Gateway provider ${provider.id} returned a tool without a valid name.`);
        }
        if (!filter || filter(tool, provider)) tools.push(tool);
      }
    }
    return tools;
  }

  async resolve(name) {
    const toolName = String(name || '').trim();
    if (!toolName) throw new Error('Gateway tool name must not be empty.');
    let fallback;
    for (const provider of this.#providers) {
      if (provider.fallback === true) {
        fallback ??= provider;
        continue;
      }
      const owns = provider.owns
        ? await provider.owns(toolName)
        : (await provider.listTools()).some(tool => tool?.name === toolName);
      if (owns) return provider;
    }
    if (fallback) return fallback;
    throw new Error(`No Gateway provider owns tool: ${toolName}`);
  }

  async callTool(name, args = {}) {
    const provider = await this.resolve(name);
    return await provider.callTool(name, args);
  }
}

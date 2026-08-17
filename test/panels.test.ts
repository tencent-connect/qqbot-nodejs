import { describe, expect, it, vi } from 'vitest';
import { QQBot } from '../src/index.js';
import { PanelApi } from '../src/protocol/api/panels.js';
import { panelPath, panelsPath, panelTargetPath } from '../src/protocol/api/routes.js';
import type { ApiClient } from '../src/protocol/api/api-client.js';
import type { TokenManager } from '../src/protocol/api/token.js';
import type { Credentials } from '../src/protocol/types.js';

const creds: Credentials = { appId: 'app', clientSecret: 'secret' };

/** Capture what PanelApi asks the HTTP client to do, without touching the network. */
function createApi(response: unknown = {}) {
  const request = vi.fn().mockResolvedValue(response);
  const client = { request } as unknown as ApiClient;
  const tokenManager = {
    getAccessToken: vi.fn().mockResolvedValue('token'),
  } as unknown as TokenManager;
  return { api: new PanelApi(client, tokenManager), request };
}

describe('panel routes', () => {
  it('builds the collection, item and target paths', () => {
    expect(panelsPath()).toBe('/v2/panels');
    expect(panelPath('p_1')).toBe('/v2/panels/p_1');
    expect(panelTargetPath('p_1')).toBe('/v2/panels/p_1/target');
  });
});

describe('PanelApi', () => {
  it('lists panels with scope only when no paging is requested', async () => {
    const { api, request } = createApi({ records: [], next_cursor: '', is_end: true });

    await api.listPanels(creds, { scope: 'c2c' });

    expect(request).toHaveBeenCalledWith('token', 'GET', '/v2/panels?scope=c2c');
  });

  it('passes cursor and limit through as query parameters', async () => {
    const { api, request } = createApi({ records: [], next_cursor: '', is_end: true });

    await api.listPanels(creds, { scope: 'group', cursor: 'c1', limit: 50 });

    expect(request).toHaveBeenCalledWith('token', 'GET', '/v2/panels?scope=group&cursor=c1&limit=50');
  });

  it('fetches one panel by id', async () => {
    const { api, request } = createApi({ panel_id: 'p_1' });

    await api.getPanel(creds, 'p_1');

    expect(request).toHaveBeenCalledWith('token', 'GET', '/v2/panels/p_1');
  });

  it('sends the create request body unchanged', async () => {
    const { api, request } = createApi({ panel_id: 'p_1' });
    const body = {
      scope: 'c2c' as const,
      target_type: 'all' as const,
      panel: { items: [{ name: '/status', desc: 'show status', type: 'command' as const }] },
    };

    await api.createPanel(creds, body);

    expect(request).toHaveBeenCalledWith('token', 'POST', '/v2/panels', body);
  });

  it('wraps the update body in a panel key', async () => {
    const { api, request } = createApi({ version: 2 });
    const panel = { items: [], remark: 'my-bot', version: 2 };

    await api.updatePanel(creds, 'p_1', panel);

    expect(request).toHaveBeenCalledWith('token', 'PUT', '/v2/panels/p_1', { panel });
  });

  it('deletes a panel', async () => {
    const { api, request } = createApi();

    await api.deletePanel(creds, 'p_1');

    expect(request).toHaveBeenCalledWith('token', 'DELETE', '/v2/panels/p_1');
  });

  it('updates the associated peers', async () => {
    const { api, request } = createApi();
    const body = { op: 'add' as const, group_openids: ['g1'] };

    await api.updatePanelTarget(creds, 'p_1', body);

    expect(request).toHaveBeenCalledWith('token', 'PUT', '/v2/panels/p_1/target', body);
  });
});

describe('QQBot panel facade', () => {
  it('exposes panelApi alongside the other protocol primitives', () => {
    const bot = new QQBot({ appId: 'app', appSecret: 'secret' });
    expect(bot.panelApi).toBeInstanceOf(PanelApi);
  });

  it('forwards its own credentials to the panel API', async () => {
    const bot = new QQBot({ appId: 'app', appSecret: 'secret' });
    const spy = vi
      .spyOn(bot.panelApi, 'listPanels')
      .mockResolvedValue({ records: [], next_cursor: '', is_end: true });

    await bot.listPanels({ scope: 'c2c' });

    expect(spy).toHaveBeenCalledWith(
      { appId: 'app', clientSecret: 'secret' },
      { scope: 'c2c' },
    );
  });
});

/**
 * Command panel API for the QQ Open Platform.
 *
 * The command panel is the list a client shows when the user taps the "/"
 * affordance in the input box. Tapping a `command` entry types its `name`
 * into the input box instead of sending it, so the entry comes back as an
 * ordinary inbound message — a bot only has to publish the panel; receiving
 * what it produces needs no special handling.
 *
 * @see https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_panels.get.html
 */

import type {
  CreatePanelRequest,
  CreatePanelResponse,
  Credentials,
  ListPanelsQuery,
  ListPanelsResponse,
  Panel,
  PanelRecord,
  UpdatePanelResponse,
  UpdatePanelTargetRequest,
} from "../types.js";
import { ApiClient } from "./api-client.js";
import { panelPath, panelsPath, panelTargetPath } from "./routes.js";
import { TokenManager } from "./token.js";

export class PanelApi {
  private readonly client: ApiClient;
  private readonly tokenManager: TokenManager;

  constructor(client: ApiClient, tokenManager: TokenManager) {
    this.client = client;
    this.tokenManager = tokenManager;
  }

  /**
   * List the panels registered for one scope.
   *
   * Results are paged: pass {@link ListPanelsResponse.next_cursor} back as
   * `cursor` until `is_end` is true.
   */
  async listPanels(creds: Credentials, query: ListPanelsQuery): Promise<ListPanelsResponse> {
    const token = await this.token(creds);
    const params = new URLSearchParams({ scope: query.scope });
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    return this.client.request<ListPanelsResponse>(
      token,
      "GET",
      `${panelsPath()}?${params.toString()}`,
    );
  }

  /** Fetch one panel, including the peers it is associated with. */
  async getPanel(creds: Credentials, panelId: string): Promise<PanelRecord> {
    const token = await this.token(creds);
    return this.client.request<PanelRecord>(token, "GET", panelPath(panelId));
  }

  /** Create a panel. Returns the id needed by every other call. */
  async createPanel(
    creds: Credentials,
    request: CreatePanelRequest,
  ): Promise<CreatePanelResponse> {
    const token = await this.token(creds);
    return this.client.request<CreatePanelResponse>(token, "POST", panelsPath(), request);
  }

  /**
   * Replace a panel's configuration.
   *
   * The body carries the panel only — scope and target are fixed at creation
   * time, and the latter is changed through {@link updatePanelTarget}.
   */
  async updatePanel(
    creds: Credentials,
    panelId: string,
    panel: Panel,
  ): Promise<UpdatePanelResponse> {
    const token = await this.token(creds);
    return this.client.request<UpdatePanelResponse>(token, "PUT", panelPath(panelId), { panel });
  }

  async deletePanel(creds: Credentials, panelId: string): Promise<void> {
    const token = await this.token(creds);
    await this.client.request(token, "DELETE", panelPath(panelId));
  }

  /**
   * Add or remove the peers a `specific` panel applies to.
   *
   * Rejected for panels created with `target_type: "all"` (error 40030021).
   */
  async updatePanelTarget(
    creds: Credentials,
    panelId: string,
    request: UpdatePanelTargetRequest,
  ): Promise<void> {
    const token = await this.token(creds);
    await this.client.request(token, "PUT", panelTargetPath(panelId), request);
  }

  private token(creds: Credentials): Promise<string> {
    return this.tokenManager.getAccessToken(creds.appId, creds.clientSecret);
  }
}

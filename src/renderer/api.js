'use strict';

// ─── SEOZ API Client ──────────────────────────────────────────────────────────
// All communication with seoz.io backend.
// Used in the renderer via fetch() — no Node.js required.

const BASE_URL = 'https://seoz.io/api';

class SeozApiClient {
  constructor() {
    this._apiKey = null;
    this._clientId = null;
  }

  setApiKey(key) { this._apiKey = key; }
  setClientId(id) { this._clientId = id; }

  _headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this._apiKey}`,
    };
  }

  async _get(path, params = {}) {
    const url = new URL(BASE_URL + path);
    Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
    const res = await fetch(url.toString(), { headers: this._headers() });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res.json();
  }

  async _post(path, body = {}) {
    const res = await fetch(BASE_URL + path, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res.json();
  }

  async _patch(path, body = {}) {
    const res = await fetch(BASE_URL + path, {
      method: 'PATCH',
      headers: this._headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res.json();
  }

  // ── Auth ──────────────────────────────────────────────────────────────────
  /** Validate API key and return workspace info */
  async validateKey() {
    return this._get('/me');
    // Returns: { id, email, name, workspace: { id, name, plan }, clients: [...] }
  }

  // ── Clients ───────────────────────────────────────────────────────────────
  async getClients() {
    return this._get('/clients');
    // Returns: [{ id, name, domain, color, seoScore, plan }]
  }

  // ── SEO Analysis ──────────────────────────────────────────────────────────
  /** Fetch stored SEO analysis for a URL (from SEOZ backend) */
  async getSeoAnalysis(url) {
    return this._get('/seo/analysis', { url, clientId: this._clientId });
    // Returns: { score, onPage: {...}, cwv: {...}, schema: [...], ... }
  }

  /** Save a fresh DOM-scraped SEO snapshot */
  async saveSeoSnapshot(data) {
    return this._post('/seo/snapshot', { clientId: this._clientId, ...data });
  }

  // ── Keywords & GSC ────────────────────────────────────────────────────────
  async getKeywords({ url, days = 28 } = {}) {
    return this._get('/keywords', { clientId: this._clientId, url, days });
    // Returns: { gscStats: { clicks, impressions, ctr, position }, keywords: [...] }
  }

  async addKeyword(keyword) {
    return this._post('/keywords', { clientId: this._clientId, keyword });
  }

  // ── Tasks ─────────────────────────────────────────────────────────────────
  async getTasks({ status } = {}) {
    return this._get('/browser/tasks', { clientId: this._clientId, status });
    // Returns: { ok, tasks: [{ id, title, description, url, severity, status, skill_type, effort_h, priority_score, ... }] }
  }

  async updateTask(taskId, updates) {
    return this._patch('/browser/tasks', { taskId, ...updates });
  }

  // ── AI Visibility ─────────────────────────────────────────────────────────
  async getAiVisibility() {
    return this._get('/ai-visibility', { clientId: this._clientId });
    // Returns: { score, models: [{name, mentions, total}], keywords: [...] }
  }

  // ── Notifications ─────────────────────────────────────────────────────────
  async getNotifications({ since } = {}) {
    return this._get('/notifications', { clientId: this._clientId, since });
    // Returns: [{ id, type, title, description, severity, createdAt, read }]
  }

  async markNotificationsRead(ids) {
    return this._post('/notifications/read', { ids });
  }

  // ── AI task suggestion ────────────────────────────────────────────────────
  async suggestTask(seoData) {
    return this._post('/ai/suggest-task', { clientId: this._clientId, seoData });
    // Returns: { title, description, priority, category }
  }
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

// Singleton
const api = new SeozApiClient();

// Export for use in renderer modules
if (typeof module !== 'undefined') module.exports = { api, ApiError };
else window.seozApi = api;

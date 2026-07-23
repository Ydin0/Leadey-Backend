const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

/** Extract a LinkedIn PUBLIC IDENTIFIER (the /in/<slug>) from a profile URL, so
 *  it can be passed to Unipile's /users/{identifier} endpoint. A full URL is
 *  rejected by Unipile (422 invalid_recipient). Tolerant of http/https, www,
 *  trailing slashes, query strings, and already-bare identifiers/provider ids. */
export function linkedinPublicIdentifier(input: string): string {
  const s = (input || "").trim();
  if (!s) return s;
  const m = s.match(/\/in\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  // Fall back to the last non-empty path segment for other /pub//profile forms.
  if (/linkedin\.com/i.test(s)) {
    const seg = s.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").filter(Boolean).pop();
    if (seg && !/^(www\.)?linkedin\.com$/i.test(seg)) return decodeURIComponent(seg);
  }
  return s; // already a public identifier or provider id
}

export interface UnipileAccount {
  id: string;
  name: string;
  type: string;
  status: string;
}

export interface UnipileProfile {
  provider_id: string;
  first_name: string;
  last_name: string;
  headline: string;
  public_identifier: string;
  /** Relationship to the connected account — used to detect an accepted
   *  connection request. Unipile returns these on the profile. */
  is_relationship?: boolean;
  network_distance?: string; // e.g. "FIRST_DEGREE" | "DISTANCE_1" | "OUT_OF_NETWORK"
}

/** One LinkedIn chat (conversation) as returned by Unipile's /chats. */
export interface UnipileChat {
  id: string;
  account_id?: string;
  /** Other party's provider ids on this chat. */
  attendee_provider_id?: string;
  attendees?: { provider_id?: string; name?: string }[];
  name?: string;
}

/** One message within a chat. */
export interface UnipileMessage {
  id: string;
  chat_id?: string;
  text?: string;
  is_sender?: boolean; // true = sent by the connected account
  sender_id?: string;
  sender_attendee_id?: string;
  timestamp?: string;
  created_at?: string;
}

export interface UnipileInviteResult {
  object: string;
}

export interface UnipileChatResult {
  object: string;
  chat_id: string;
}

export interface UnipileCheckpointResult {
  account_id: string;
  status: string;
  checkpoint?: { type: string };
}

export class UnipileClient {
  private baseUrl: string;
  private apiKey: string;
  private requestCount = 0;
  private windowStart = Date.now();

  constructor(dsn: string, apiKey: string) {
    this.baseUrl = `https://${dsn}/api/v1`;
    this.apiKey = apiKey;
  }

  private async rateLimitGuard(): Promise<void> {
    const now = Date.now();
    if (now - this.windowStart >= RATE_WINDOW_MS) {
      this.requestCount = 0;
      this.windowStart = now;
    }
    if (this.requestCount >= RATE_LIMIT) {
      const waitMs = RATE_WINDOW_MS - (now - this.windowStart);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      this.requestCount = 0;
      this.windowStart = Date.now();
    }
    this.requestCount++;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    await this.rateLimitGuard();

    const url = `${this.baseUrl}${path}`;

    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY": this.apiKey,
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Unipile API error ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    return response.json() as Promise<T>;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.request<unknown>("GET", "/accounts");
      return true;
    } catch {
      return false;
    }
  }

  async listAccounts(): Promise<UnipileAccount[]> {
    const result = await this.request<{ items: UnipileAccount[] }>("GET", "/accounts");
    return result.items || [];
  }

  async connectAccount(
    username: string,
    password: string,
  ): Promise<UnipileCheckpointResult> {
    return this.request<UnipileCheckpointResult>("POST", "/accounts", {
      provider: "LINKEDIN",
      username,
      password,
    });
  }

  async resolveCheckpoint(
    accountId: string,
    code: string,
  ): Promise<UnipileCheckpointResult> {
    return this.request<UnipileCheckpointResult>(
      "POST",
      "/accounts/checkpoint",
      { account_id: accountId, code },
    );
  }

  async resolveProfile(
    accountId: string,
    linkedinUrlOrId: string,
  ): Promise<UnipileProfile> {
    // Unipile's /users/{identifier} expects the LinkedIn PUBLIC IDENTIFIER (the
    // /in/<slug> part) or a provider id — NOT a full profile URL. Passing the
    // whole URL 422s ("invalid_recipient"), so extract the slug first.
    const identifier = linkedinPublicIdentifier(linkedinUrlOrId);
    const encoded = encodeURIComponent(identifier);
    return this.request<UnipileProfile>(
      "GET",
      `/users/${encoded}?account_id=${encodeURIComponent(accountId)}`,
    );
  }

  async sendInvitation(
    accountId: string,
    providerId: string,
    message?: string,
  ): Promise<UnipileInviteResult> {
    const body: Record<string, string> = {
      provider_id: providerId,
      account_id: accountId,
    };
    if (message) {
      body.message = message;
    }
    return this.request<UnipileInviteResult>("POST", "/users/invite", body);
  }

  async sendMessage(
    accountId: string,
    providerId: string,
    text: string,
  ): Promise<UnipileChatResult> {
    return this.request<UnipileChatResult>("POST", "/chats", {
      account_id: accountId,
      text,
      attendees_ids: [providerId],
    });
  }

  /** List the account's chats (conversations), newest first. */
  async listChats(accountId: string, limit = 50): Promise<UnipileChat[]> {
    const result = await this.request<{ items?: UnipileChat[] }>(
      "GET",
      `/chats?account_id=${encodeURIComponent(accountId)}&limit=${limit}`,
    );
    return result.items || [];
  }

  /** List messages in a chat, newest first. */
  async listChatMessages(chatId: string, limit = 50): Promise<UnipileMessage[]> {
    const result = await this.request<{ items?: UnipileMessage[] }>(
      "GET",
      `/chats/${encodeURIComponent(chatId)}/messages?limit=${limit}`,
    );
    return result.items || [];
  }

  async getAccount(accountId: string): Promise<UnipileAccount> {
    return this.request<UnipileAccount>("GET", `/accounts/${encodeURIComponent(accountId)}`);
  }

  async deleteAccount(accountId: string): Promise<void> {
    await this.request<unknown>("DELETE", `/accounts/${encodeURIComponent(accountId)}`);
  }

  /** Unipile's hosted auth wizard — it renders the WhatsApp QR (and handles
   *  refresh/expiry) on Unipile's own page, then redirects back and POSTs the
   *  new account id to notifyUrl. Keeps QR mechanics entirely off our UI. */
  async createHostedAuthLink(opts: {
    providers: string[];
    /** Correlation token echoed back in the notify payload (we pass orgId). */
    name: string;
    notifyUrl?: string;
    successRedirectUrl?: string;
    failureRedirectUrl?: string;
  }): Promise<{ url: string }> {
    return this.request<{ url: string }>("POST", "/hosted/accounts/link", {
      type: "create",
      providers: opts.providers,
      api_url: this.baseUrl.replace(/\/api\/v1$/, ""),
      expiresOn: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      name: opts.name,
      ...(opts.notifyUrl ? { notify_url: opts.notifyUrl } : {}),
      ...(opts.successRedirectUrl ? { success_redirect_url: opts.successRedirectUrl } : {}),
      ...(opts.failureRedirectUrl ? { failure_redirect_url: opts.failureRedirectUrl } : {}),
    });
  }

  async listWebhooks(): Promise<{ id: string; request_url: string; source: string }[]> {
    const result = await this.request<{ items?: { id: string; request_url: string; source: string }[] }>(
      "GET",
      "/webhooks",
    );
    return result.items || [];
  }

  /** Register a messaging webhook (new-message events for every account on
   *  the Unipile workspace). Idempotence is the caller's job (listWebhooks). */
  async createMessagingWebhook(requestUrl: string): Promise<void> {
    await this.request<unknown>("POST", "/webhooks", {
      source: "messaging",
      request_url: requestUrl,
      name: "leadey-messaging",
    });
  }
}

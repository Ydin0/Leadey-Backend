const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 60_000;

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
    linkedinUrl: string,
  ): Promise<UnipileProfile> {
    const encoded = encodeURIComponent(linkedinUrl);
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
}

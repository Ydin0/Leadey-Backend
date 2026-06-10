const BASE_URL = "https://server.smartlead.ai/api/v1";
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export interface SmartleadEmailAccount {
  id: number;
  email: string;
  from_name: string;
  is_active: boolean;
  /** Real fields returned by GET /email-accounts (optional — parsed
   *  defensively since Smartlead's shape varies by account type). */
  from_email?: string;
  type?: string; // GMAIL | OUTLOOK | SMTP | GMAIL_OAUTH | OUTLOOK_OAUTH
  message_per_day?: number;
  daily_sent_count?: number;
  is_smtp_success?: boolean;
  warmup_details?: {
    status?: string; // ACTIVE | PAUSED | etc.
    warmup_reputation?: string | number;
  } | null;
  [key: string]: unknown;
}

export interface SmartleadSequenceVariant {
  subject: string;
  email_body: string;
  variant_label?: string;
  variant_distribution_percentage?: number;
}

export interface SmartleadSequence {
  seq_number: number;
  seq_type: string;
  seq_delay_details: { delay_in_days: number };
  seq_variants: SmartleadSequenceVariant[];
}

export interface SmartleadLeadInput {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  phone_number?: string;
  linkedin_profile?: string;
  [key: string]: string | undefined;
}

export interface SmartleadClientResult {
  id: number;
  api_key?: string;
}

export interface SmartleadAddEmailAccountInput {
  from_name: string;
  from_email: string;
  user_name: string;
  password: string;
  smtp_host: string;
  smtp_port: number;
  imap_host: string;
  imap_port: number;
  warmup_enabled: boolean;
  type?: string; // GMAIL | OUTLOOK | SMTP
  max_email_per_day?: number;
  total_warmup_per_day?: number;
  daily_rampup?: number;
  reply_rate_percentage?: number;
  client_id?: number;
}

export interface SmartleadAddEmailAccountResult {
  id: number;
  is_smtp_success?: boolean;
  is_imap_success?: boolean;
}

export class SmartleadClient {
  private apiKey: string;
  private requestCount = 0;
  private windowStart = Date.now();

  constructor(apiKey: string) {
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

    const separator = path.includes("?") ? "&" : "?";
    const url = `${BASE_URL}${path}${separator}api_key=${this.apiKey}`;

    const init: RequestInit = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }

    const response = await fetch(url, init);

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(
        `Smartlead API error ${response.status}: ${text.slice(0, 200)}`,
      );
    }

    return response.json() as Promise<T>;
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.request<unknown>("GET", "/email-accounts");
      return true;
    } catch {
      return false;
    }
  }

  async createCampaign(
    name: string,
  ): Promise<{ ok: boolean; id: number; name: string }> {
    return this.request("POST", "/campaigns/create", { name });
  }

  async saveSequences(
    campaignId: number,
    sequences: SmartleadSequence[],
  ): Promise<unknown> {
    return this.request("POST", `/campaigns/${campaignId}/sequences`, {
      sequences,
    });
  }

  async addLeads(
    campaignId: number,
    leadList: SmartleadLeadInput[],
    settings?: { return_lead_ids?: boolean },
  ): Promise<{
    ok?: boolean;
    emailToLeadIdMap?: {
      newlyAddedLeads?: Record<string, number>;
    };
  }> {
    return this.request("POST", `/campaigns/${campaignId}/leads`, {
      lead_list: leadList,
      settings: settings || { return_lead_ids: true },
    });
  }

  async getEmailAccounts(): Promise<SmartleadEmailAccount[]> {
    return this.request("GET", "/email-accounts");
  }

  async addEmailAccountsToCampaign(
    campaignId: number,
    emailAccountIds: number[],
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/campaigns/${campaignId}/email-accounts`,
      { email_account_ids: emailAccountIds },
    );
  }

  async setCampaignStatus(
    campaignId: number,
    status: "START" | "PAUSED" | "STOPPED",
  ): Promise<unknown> {
    return this.request("POST", `/campaigns/${campaignId}/status`, {
      status,
    });
  }

  async configureWebhook(
    campaignId: number,
    webhookUrl: string,
  ): Promise<unknown> {
    return this.request("POST", `/campaigns/${campaignId}/webhooks`, {
      webhook_url: webhookUrl,
    });
  }

  /** Create a white-label client (one per Leadey org). */
  async createClient(input: {
    name: string;
    email: string;
    password?: string;
    permission?: string[];
  }): Promise<SmartleadClientResult> {
    const res = await this.request<{
      ok?: boolean;
      data?: SmartleadClientResult;
      id?: number;
      client_id?: number;
      api_key?: string;
    }>("POST", "/client/save", input);
    const data = res.data ?? res;
    const id = data.id ?? (res as { client_id?: number }).client_id;
    if (id == null) throw new Error("Smartlead createClient returned no id");
    return { id, api_key: data.api_key };
  }

  /** Add an email account (SMTP/IMAP or provider) — optionally scoped to a
   *  client. Enables warmup. */
  async addEmailAccount(
    input: SmartleadAddEmailAccountInput,
  ): Promise<SmartleadAddEmailAccountResult> {
    const res = await this.request<{
      ok?: boolean;
      data?: SmartleadAddEmailAccountResult;
      id?: number;
      is_smtp_success?: boolean;
      is_imap_success?: boolean;
    }>("POST", "/email-accounts/save", input);
    const data = res.data ?? res;
    if (data.id == null) throw new Error("Smartlead addEmailAccount returned no id");
    return {
      id: data.id,
      is_smtp_success: data.is_smtp_success,
      is_imap_success: data.is_imap_success,
    };
  }
}

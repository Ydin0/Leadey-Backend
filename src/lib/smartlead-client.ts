const BASE_URL = "https://server.smartlead.ai/api/v1";
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

export interface SmartleadEmailAccount {
  id: number;
  email: string;
  from_name: string;
  is_active: boolean;
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
}

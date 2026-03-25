const BASE_URL = "https://app.bettercontact.rocks/api/v2";
const MAX_BATCH_SIZE = 100;

export interface BetterContactInput {
  first_name: string;
  last_name: string;
  company?: string;
  company_domain?: string;
  linkedin_url?: string;
}

export interface BetterContactSubmitResponse {
  status: string;
  id: string; // request ID for polling
}

export interface BetterContactResult {
  status: string; // "finished", "processing", "failed"
  data?: Array<{
    first_name?: string;
    last_name?: string;
    linkedin_url?: string;
    email?: string;
    email_status?: string; // "verified", "catch-all", "risky"
    phone?: string;
    phone_status?: string; // "valid", null
  }>;
}

export class BetterContactClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
      },
    };
    if (body) init.body = JSON.stringify(body);

    const response = await fetch(url, init);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`BetterContact API error ${response.status}: ${text}`);
    }
    return response.json() as Promise<T>;
  }

  async submitBatch(contacts: BetterContactInput[]): Promise<BetterContactSubmitResponse> {
    const chunk = contacts.slice(0, MAX_BATCH_SIZE);
    return this.request<BetterContactSubmitResponse>("POST", "/async", {
      data: chunk,
      enrich_email_address: true,
      enrich_phone_number: true,
    });
  }

  /**
   * Submit all contacts in chunks of 100, returning all request IDs.
   */
  async submitAll(contacts: BetterContactInput[]): Promise<BetterContactSubmitResponse[]> {
    const responses: BetterContactSubmitResponse[] = [];
    for (let i = 0; i < contacts.length; i += MAX_BATCH_SIZE) {
      const chunk = contacts.slice(i, i + MAX_BATCH_SIZE);
      const resp = await this.request<BetterContactSubmitResponse>("POST", "/async", {
        data: chunk,
        enrich_email_address: true,
        enrich_phone_number: true,
      });
      responses.push(resp);
    }
    return responses;
  }

  async getBatchResults(requestId: string): Promise<BetterContactResult> {
    return this.request<BetterContactResult>("GET", `/async/${requestId}`);
  }
}

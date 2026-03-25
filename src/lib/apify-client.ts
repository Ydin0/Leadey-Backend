const BASE_URL = "https://api.apify.com/v2";
const ACTOR_ID = "harvestapi~linkedin-company-employees";

// Seniority name → Apify seniority level ID
const SENIORITY_MAP: Record<string, string> = {
  "C-Level": "310",
  VP: "300",
  Director: "220",
  Manager: "210",
  Owner: "320",
  Head: "300", // Treated same as VP
  Senior: "200",
};

export interface ApifyRunInput {
  companies: string[];
  profileScraperMode?: string;
  jobTitles?: string[];
  seniorityLevelIds?: string[];
  maxItems?: number;
  companyBatchMode?: "all_at_once" | "one_by_one";
}

export interface ApifyRunResponse {
  data: {
    id: string;
    defaultDatasetId: string;
    status: string;
  };
}

export interface ApifyRunStatus {
  data: {
    id: string;
    status: string; // READY, RUNNING, SUCCEEDED, FAILED, ABORTED, TIMED-OUT
    defaultDatasetId: string;
    stats?: {
      inputBodyLen?: number;
      itemCount?: number;
    };
  };
}

export interface ApifyProfileItem {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  headline?: string;
  profileUrl?: string;
  linkedinUrl?: string;
  location?: string;
  profileImageUrl?: string;
  title?: string;
  companyName?: string;
  companyUrl?: string;
  companyLinkedinUrl?: string;
  [key: string]: unknown;
}

export function mapSeniorityLevels(levels: string[]): string[] {
  const ids: string[] = [];
  for (const level of levels) {
    const id = SENIORITY_MAP[level];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export class ApifyClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${BASE_URL}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.token}`,
      },
    };
    if (body) init.body = JSON.stringify(body);

    const response = await fetch(url, init);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Apify API error ${response.status}: ${text}`);
    }
    return response.json() as Promise<T>;
  }

  async startRun(input: ApifyRunInput): Promise<ApifyRunResponse> {
    return this.request<ApifyRunResponse>(
      "POST",
      `/acts/${ACTOR_ID}/runs`,
      input,
    );
  }

  async getRunStatus(runId: string): Promise<ApifyRunStatus> {
    return this.request<ApifyRunStatus>(
      "GET",
      `/acts/${ACTOR_ID}/runs/${runId}`,
    );
  }

  async abortRun(runId: string): Promise<void> {
    await this.request<unknown>(
      "POST",
      `/acts/${ACTOR_ID}/runs/${runId}/abort`,
    );
  }

  async getDatasetItems(
    datasetId: string,
    offset = 0,
    limit = 1000,
  ): Promise<ApifyProfileItem[]> {
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(limit),
    });
    const result = await this.request<ApifyProfileItem[]>(
      "GET",
      `/datasets/${datasetId}/items?${params}`,
    );
    return result;
  }
}

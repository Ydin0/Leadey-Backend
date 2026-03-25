const THEIRSTACK_API_BASE = "https://api.theirstack.com";

// ─── Request Types ────────────────────────────────────────────────────

export interface TheirStackJobSearchParams {
  // Pagination
  page?: number;
  limit?: number;
  offset?: number;
  cursor?: string;

  // Job title filters
  job_title_or?: string[];
  job_title_not?: string[];
  job_title_pattern_and?: string[];
  job_title_pattern_or?: string[];
  job_title_pattern_not?: string[];

  // Location / country
  job_country_code_or?: string[];
  job_country_code_not?: string[];
  job_location_pattern_or?: string[];
  job_location_pattern_not?: string[];

  // Seniority
  job_seniority_or?: string[];

  // Remote
  remote?: boolean | null;

  // Date filters (at least one required)
  posted_at_max_age_days?: number;
  posted_at_gte?: string;
  posted_at_lte?: string;
  discovered_at_max_age_days?: number;
  discovered_at_gte?: string;
  discovered_at_lte?: string;

  // Description filters
  job_description_pattern_or?: string[];
  job_description_pattern_not?: string[];
  job_description_contains_or?: string[];
  job_description_contains_not?: string[];

  // Salary
  min_salary_usd?: number;
  max_salary_usd?: number;

  // Tech stack
  job_technology_slug_or?: string[];
  job_technology_slug_and?: string[];
  job_technology_slug_not?: string[];

  // Employment
  employment_statuses_or?: string[];
  easy_apply?: boolean;

  // Company filters
  company_name_or?: string[];
  company_domain_or?: string[];
  company_linkedin_url_or?: string[];
  min_employee_count?: number;
  max_employee_count?: number;
  min_revenue_usd?: number;
  max_revenue_usd?: number;
  min_funding_usd?: number;
  max_funding_usd?: number;
  funding_stage_or?: string[];
  industry_or?: string[];
  industry_not?: string[];
  investors_or?: string[];
  company_technology_slug_or?: string[];
  company_technology_slug_and?: string[];
  company_technology_slug_not?: string[];
  only_yc_companies?: boolean;
  company_list_id_or?: string[];
  company_country_code_or?: string[];
  company_country_code_not?: string[];
  company_city_pattern_or?: string[];
  company_description_pattern_or?: string[];
  company_description_pattern_not?: string[];
  company_type?: "recruiting_agency" | "direct_employer" | "all";

  // Source filters
  url_domain_or?: string[];
  url_domain_not?: string[];

  // Data control
  include_total_results?: boolean;
}

// ─── Response Types ───────────────────────────────────────────────────

export interface TheirStackCompanyObject {
  id: string;
  name: string;
  domain: string;
  industry: string;
  country: string;
  country_code: string;
  employee_count: number;
  logo: string;
  linkedin_url: string;
  founded_year: number;
  annual_revenue_usd: number;
  total_funding_usd: number;
  funding_stage: string;
  employee_count_range: string;
  long_description: string;
  city: string;
  company_keywords: string[];
  technology_slugs: string[];
  technology_names: string[];
}

export interface TheirStackHiringTeamMember {
  first_name: string;
  full_name: string;
  image_url: string;
  linkedin_url: string;
  role: string;
}

export interface TheirStackJob {
  id: number;
  job_title: string;
  url: string;
  final_url: string;
  source_url: string;
  date_posted: string;
  company: string;
  location: string;
  short_location: string;
  long_location: string;
  remote: boolean;
  hybrid: boolean;
  salary_string: string;
  min_annual_salary_usd: number | null;
  max_annual_salary_usd: number | null;
  avg_annual_salary_usd: number | null;
  salary_currency: string;
  country: string;
  country_code: string;
  country_codes: string[];
  cities: string[];
  seniority: string;
  discovered_at: string;
  company_domain: string;
  company_object: TheirStackCompanyObject | null;
  hiring_team: TheirStackHiringTeamMember[];
  reposted: boolean;
  employment_statuses: string[];
  description: string;
  normalized_title: string;
  technology_slugs: string[];
}

export interface TheirStackJobSearchResponse {
  metadata: {
    total_results: number;
    truncated_results: number;
    total_companies: number;
  };
  data: TheirStackJob[];
}

// ─── Client ───────────────────────────────────────────────────────────

export class TheirStackClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async searchJobs(
    params: TheirStackJobSearchParams,
  ): Promise<TheirStackJobSearchResponse> {
    const res = await fetch(`${THEIRSTACK_API_BASE}/v1/jobs/search`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(params),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg =
        body?.error?.title || body?.error?.description || res.statusText;
      throw new Error(`TheirStack API error ${res.status}: ${msg}`);
    }

    return res.json();
  }
}

export interface NormalizedJob {
  jobTitle: string;
  company: string;
  companyDomain: string | null;
  location: string | null;
  jobUrl: string | null;
  description: string | null;
  salary: string | null;
  postedAt: Date | null;
  jobType: string | null;
  isRemote: boolean;
  seniority: string | null;
  companySize: number | null;
  companyIndustry: string | null;
  companyLogo: string | null;
  hiringTeam: Array<{ name: string; role: string; linkedinUrl: string }>;
}

interface ScoreParams {
  keywords: string[];
  excludedKeywords: string[];
}

const SENIORITY_KEYWORDS = [
  "vp", "vice president", "director", "head of", "chief",
  "cto", "cfo", "ceo", "coo", "cmo", "cro", "svp", "evp",
  "founder", "partner", "principal", "senior director",
];

export function scoreSignal(job: NormalizedJob, params: ScoreParams): number {
  let score = 50;
  const text = `${job.jobTitle} ${job.description || ""}`.toLowerCase();

  // Keyword match bonus (up to +30)
  const matchedKeywords = params.keywords.filter((kw) =>
    text.includes(kw.toLowerCase()),
  );
  if (params.keywords.length > 0 && matchedKeywords.length > 0) {
    score += Math.min(30, matchedKeywords.length * 10);
  }

  // Recency bonus (up to +10)
  if (job.postedAt) {
    const daysAgo = (Date.now() - job.postedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysAgo <= 1) score += 10;
    else if (daysAgo <= 3) score += 7;
    else if (daysAgo <= 7) score += 4;
    else if (daysAgo <= 14) score += 2;
  }

  // Seniority bonus (up to +10)
  const titleLower = job.jobTitle.toLowerCase();
  if (SENIORITY_KEYWORDS.some((kw) => titleLower.includes(kw))) {
    score += 10;
  }

  // Excluded keyword penalty (-20 each)
  for (const excluded of params.excludedKeywords) {
    if (text.includes(excluded.toLowerCase())) {
      score -= 20;
    }
  }

  return Math.max(0, Math.min(100, score));
}

import { getAuth } from "@clerk/express";
import { ApiError } from "./helpers";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getOrgId(req: any): string {
  const auth = getAuth(req);
  if (!auth?.orgId) {
    throw new ApiError(403, "No organization selected");
  }
  return auth.orgId;
}

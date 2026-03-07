import { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { ApiError } from "./helpers";

/**
 * Express middleware that gates routes to platform admins only.
 *
 * Checks for role === "admin" in the session claims. Clerk puts public metadata
 * under `sessionClaims.metadata` when the session token template includes:
 *   { "metadata": "{{user.public_metadata}}" }
 *
 * This also checks `sessionClaims.public_metadata` as a fallback for alternative
 * Clerk configurations.
 */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const auth = getAuth(req);
  const claims = auth?.sessionClaims as Record<string, any> | undefined;

  // Check both common locations for public metadata in session claims
  const role =
    claims?.metadata?.role ||
    claims?.public_metadata?.role ||
    null;

  if (role !== "admin") {
    throw new ApiError(403, "Admin access required");
  }

  next();
}

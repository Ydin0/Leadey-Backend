import { Request, Response, NextFunction } from "express";
import { verifyToken } from "@clerk/backend";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { users } from "../db/schema/organizations";
import { ApiError } from "./helpers";

/**
 * Verifies the Bearer token directly using @clerk/backend's verifyToken.
 * Bypasses clerkMiddleware/requireAuth entirely to avoid SDK compatibility issues.
 */
export async function requireApiAuth(req: Request, _res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return next(new ApiError(401, "Authentication required"));
  }

  const token = authHeader.substring(7);
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    });

    // Attach auth info for downstream middleware
    (req as any)._adminAuth = { userId: payload.sub };
    next();
  } catch {
    return next(new ApiError(401, "Invalid or expired token"));
  }
}

/**
 * Checks the `platform_role` column in the users table.
 * Must be used after requireApiAuth.
 */
export async function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const userId = (req as any)._adminAuth?.userId;
  if (!userId) {
    return next(new ApiError(401, "Authentication required"));
  }

  try {
    const result = await db
      .select({ platformRole: users.platformRole })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!result[0] || result[0].platformRole !== "admin") {
      return next(new ApiError(403, "Admin access required"));
    }

    next();
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    return next(new ApiError(500, "Failed to verify admin access"));
  }
}

import { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { organizations } from "../db/schema/organizations";
import { getOrgId } from "./auth";

const THREE_DAYS_MS = 3 * 86400000;

// Paths exempt from plan enforcement
const EXEMPT_PATHS = ["/api/billing", "/api/admin"];

export function planGuard() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Skip for exempt paths
    if (EXEMPT_PATHS.some((p) => req.path.startsWith(p))) {
      return next();
    }

    // Skip for GET requests to settings (always allow viewing)
    if (req.method === "GET" && req.path.startsWith("/api/settings")) {
      return next();
    }

    let orgId: string;
    try {
      orgId = getOrgId(req);
    } catch {
      return next(); // Auth middleware will handle this
    }

    const [org] = await db
      .select({
        plan: organizations.plan,
        planStatus: organizations.planStatus,
        trialEndsAt: organizations.trialEndsAt,
        currentPeriodEnd: organizations.currentPeriodEnd,
        cardSetupRequired: organizations.cardSetupRequired,
        stripeSubscriptionId: organizations.stripeSubscriptionId,
      })
      .from(organizations)
      .where(eq(organizations.id, orgId));

    if (!org) return next();

    const now = Date.now();

    // Signup payment wall — org flagged at creation with no subscription yet
    // must add a card before doing anything mutating. GETs stay allowed so the
    // app can render and the frontend can redirect to /start-trial.
    if (org.cardSetupRequired && !org.stripeSubscriptionId) {
      if (req.method !== "GET") {
        res.status(403).json({
          error: { message: "Please add a payment method to start your free trial.", code: "PAYMENT_SETUP_REQUIRED" },
        });
        return;
      }
    }

    // Trial expired check
    if (org.plan === "trial" && org.trialEndsAt && org.trialEndsAt.getTime() < now) {
      if (req.method !== "GET") {
        res.status(403).json({
          error: { message: "Your free trial has expired. Please upgrade to continue.", code: "TRIAL_EXPIRED" },
        });
        return;
      }
    }

    // Past due — 3-day grace period then read-only
    if (org.planStatus === "past_due") {
      const periodEnd = org.currentPeriodEnd?.getTime() || now;
      if (now > periodEnd + THREE_DAYS_MS) {
        if (req.method !== "GET") {
          res.status(403).json({
            error: { message: "Your payment is overdue. Please update your payment method.", code: "PAYMENT_REQUIRED" },
          });
          return;
        }
      }
    }

    // Cancelled — read-only
    if (org.plan === "cancelled" || org.planStatus === "cancelled") {
      if (req.method !== "GET") {
        res.status(403).json({
          error: { message: "Your subscription has been cancelled. Please reactivate to continue.", code: "SUBSCRIPTION_CANCELLED" },
        });
        return;
      }
    }

    next();
  };
}

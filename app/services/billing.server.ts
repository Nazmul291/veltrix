/**
 * Billing logic on top of paddle.server.ts.
 *
 * Trust model:
 * - User.plan changes only here, and only from subscription state fetched from
 *   the Paddle API. Never from client input, and never from webhook payload fields.
 * - A new subscription maps to a user only through a checkout transaction the
 *   server created itself (BillingCheckout). custom_data is ignored, because
 *   Paddle.js with the public client token can attach arbitrary customData.
 */
import { Prisma, type Plan, type SubscriptionStatus } from "@prisma/client";
import { PLAN_LIMITS, PLAN_RANK, RESOURCE_TYPES, type PlanId } from "~/lib/plans";
import { writeAuditLog, type RequestContext } from "./audit.server";
import { getProviderCredentials } from "./credentials.server";
import { prisma } from "./db.server";
import {
  cancelAtPeriodEnd,
  changeSubscriptionPrice,
  createCheckoutTransaction,
  createPortalUrl,
  getSubscription,
  removeScheduledChange,
  type PaddleSubscription,
  type PaddleWebhookEvent,
} from "./paddle.server";

export class BillingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}

const STATUS_MAP: Record<PaddleSubscription["status"], SubscriptionStatus> = {
  active: "ACTIVE",
  trialing: "TRIALING",
  past_due: "PAST_DUE",
  paused: "PAUSED",
  canceled: "CANCELED",
};

/** These statuses grant the paid plan. PAST_DUE keeps it while Paddle retries the payment. */
const ENTITLED = new Set<SubscriptionStatus>(["ACTIVE", "TRIALING", "PAST_DUE"]);

async function priceIds() {
  const { priceIdPro, priceIdTeam } = await getProviderCredentials("PADDLE");
  return { PRO: priceIdPro, TEAM: priceIdTeam } as const;
}

async function planForPrice(priceId: string): Promise<Plan | null> {
  const ids = await priceIds();
  if (priceId === ids.PRO) return "PRO";
  if (priceId === ids.TEAM) return "TEAM";
  return null;
}

// ─── Read model for the billing page ────────────────────────────────────────

export interface BillingSubscriptionDTO {
  status: SubscriptionStatus;
  plan: PlanId;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
}

export async function getBillingState(userId: string) {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  const subscription: BillingSubscriptionDTO | null =
    sub && sub.status !== "CANCELED"
      ? {
          status: sub.status,
          plan: sub.plan,
          currentPeriodEnd: sub.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        }
      : null;
  return { subscription };
}

/** Public Paddle.js config. Null when billing isn't configured. Never includes secret fields. */
export async function getPaddleClientConfig() {
  try {
    const { clientToken, environment } = await getProviderCredentials("PADDLE");
    return { clientToken, environment: environment === "production" ? "production" : "sandbox" } as const;
  } catch {
    return null;
  }
}

// ─── Downgrade guard ────────────────────────────────────────────────────────

/** Blocks moving to a plan whose limits current usage already exceeds. */
async function assertFitsPlan(userId: string, target: PlanId) {
  const live = await prisma.resource.groupBy({
    by: ["type"],
    where: { ownerId: userId, status: { notIn: ["DELETED", "FAILED"] } },
    _count: { _all: true },
  });
  const over = RESOURCE_TYPES.filter((t) => (live.find((l) => l.type === t)?._count._all ?? 0) > PLAN_LIMITS[target].maxResources[t]);
  if (over.length) {
    throw new BillingError(
      `Your current resources exceed the ${target} plan limits (${over.join(", ").toLowerCase()}). Delete some first, then switch plans.`,
    );
  }
}

// ─── User actions ───────────────────────────────────────────────────────────

type Actor = { id: string; email: string; paddleCustomerId: string | null } & { context: RequestContext };

async function activeSubscription(userId: string) {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  return sub && ENTITLED.has(sub.status) ? sub : null;
}

/** New subscriber: returns a transaction ID for Paddle.js to open. */
export async function startCheckout(user: Actor, plan: Exclude<PlanId, "FREE">): Promise<string> {
  if (await activeSubscription(user.id)) throw new BillingError("You already have a subscription. Change plans instead.");

  const priceId = (await priceIds())[plan];
  const transactionId = await createCheckoutTransaction({ priceId, customerId: user.paddleCustomerId, userId: user.id });

  await prisma.billingCheckout.create({ data: { transactionId, userId: user.id, plan, priceId } });
  await writeAuditLog(prisma, {
    actorId: user.id,
    action: "billing.checkout_started",
    targetType: "BillingCheckout",
    targetId: transactionId,
    metadata: { plan },
    context: user.context,
  });
  return transactionId;
}

/** Existing subscriber switching between paid plans (prorated), or to FREE (cancels at period end). */
export async function changePlan(user: Actor, target: PlanId) {
  const sub = await activeSubscription(user.id);
  if (!sub) throw new BillingError("You don't have an active subscription.");
  if (sub.status === "PAST_DUE") throw new BillingError("Update your payment method before changing plans.");
  if (target === sub.plan && !sub.cancelAtPeriodEnd) throw new BillingError(`You're already on ${target}.`);
  if (PLAN_RANK[target] < PLAN_RANK[sub.plan]) await assertFitsPlan(user.id, target);

  if (target === "FREE") {
    await cancelAtPeriodEnd(sub.paddleSubscriptionId);
  } else {
    if (sub.cancelAtPeriodEnd) await removeScheduledChange(sub.paddleSubscriptionId);
    if (target !== sub.plan) await changeSubscriptionPrice(sub.paddleSubscriptionId, (await priceIds())[target]);
  }

  await writeAuditLog(prisma, {
    actorId: user.id,
    action: "billing.plan_change_requested",
    targetType: "Subscription",
    targetId: sub.id,
    metadata: { from: sub.plan, to: target },
    context: user.context,
  });
  // Re-read the result instead of waiting for the webhook, so the page updates right away.
  await syncSubscription(sub.paddleSubscriptionId, user.id);
}

export async function resumeSubscription(user: Actor) {
  const sub = await activeSubscription(user.id);
  if (!sub?.cancelAtPeriodEnd) throw new BillingError("There's no scheduled cancellation to undo.");
  await removeScheduledChange(sub.paddleSubscriptionId);
  await writeAuditLog(prisma, {
    actorId: user.id,
    action: "billing.cancellation_undone",
    targetType: "Subscription",
    targetId: sub.id,
    context: user.context,
  });
  await syncSubscription(sub.paddleSubscriptionId, user.id);
}

export async function getPortalUrl(user: Actor): Promise<string> {
  const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
  const customerId = sub?.paddleCustomerId ?? user.paddleCustomerId;
  if (!customerId) throw new BillingError("No billing account yet. Subscribe to a plan first.");
  return createPortalUrl(customerId, sub ? [sub.paddleSubscriptionId] : []);
}

// ─── Sync from Paddle (the only writer of User.plan) ────────────────────────

export async function syncSubscription(paddleSubscriptionId: string, userId: string) {
  const remote = await getSubscription(paddleSubscriptionId);
  const priceId = remote.items[0]?.price.id;
  const plan = priceId ? await planForPrice(priceId) : null;
  if (!plan) throw new BillingError(`Subscription ${paddleSubscriptionId} has an unknown price ${priceId ?? "(none)"}`);

  const status = STATUS_MAP[remote.status];
  const effectivePlan: Plan = ENTITLED.has(status) ? plan : "FREE";
  const data = {
    paddleSubscriptionId: remote.id,
    paddleCustomerId: remote.customer_id,
    status,
    plan,
    priceId: priceId!,
    currentPeriodEnd: remote.current_billing_period ? new Date(remote.current_billing_period.ends_at) : null,
    cancelAtPeriodEnd: remote.scheduled_change?.action === "cancel",
    lastSyncedAt: new Date(),
  };

  return prisma.$transaction(async (tx) => {
    const previous = await tx.subscription.findUnique({ where: { userId } });
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { plan: true } });

    // A canceled leftover must not overwrite a newer live subscription
    // (e.g. a late webhook for an old subscription after a re-subscribe).
    if (previous && previous.paddleSubscriptionId !== remote.id && ENTITLED.has(previous.status) && !ENTITLED.has(status)) {
      return { ignored: true as const };
    }
    if (previous && previous.paddleSubscriptionId !== remote.id && ENTITLED.has(previous.status) && ENTITLED.has(status)) {
      // Two live subscriptions (e.g. a double checkout). Keep the newest, and flag it for a refund review.
      await tx.auditLog.create({
        data: {
          action: "billing.duplicate_subscription",
          targetType: "User",
          targetId: userId,
          metadata: { kept: remote.id, replaced: previous.paddleSubscriptionId },
          userAgent: "system:billing",
        },
      });
    }

    await tx.subscription.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    await tx.user.update({ where: { id: userId }, data: { plan: effectivePlan, paddleCustomerId: remote.customer_id } });

    if (user.plan !== effectivePlan) {
      await tx.auditLog.create({
        data: {
          action: "billing.plan_changed",
          targetType: "User",
          targetId: userId,
          metadata: { from: user.plan, to: effectivePlan, status, subscription: remote.id },
          userAgent: "system:billing",
        },
      });
    }
    return { ignored: false as const, plan: effectivePlan };
  });
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

export type WebhookResult = "processed" | "duplicate" | "ignored";

/**
 * Idempotent: the event ID is recorded only after handling succeeds. If
 * handling throws, the caller returns 5xx and Paddle redelivers.
 */
export async function handlePaddleEvent(event: PaddleWebhookEvent): Promise<WebhookResult> {
  if (await prisma.webhookEvent.findUnique({ where: { id: event.event_id } })) return "duplicate";

  let result: WebhookResult = "ignored";
  if (event.event_type.startsWith("subscription.") && typeof event.data.id === "string") {
    const userId = await resolveSubscriptionOwner(event.data.id, event.data.transaction_id);
    if (userId) {
      await syncSubscription(event.data.id, userId);
      result = "processed";
    } else {
      await writeAuditLog(prisma, {
        actorId: null,
        action: "billing.unmatched_subscription",
        targetType: "PaddleSubscription",
        targetId: event.data.id,
        metadata: { event: event.event_type, eventId: event.event_id },
        context: { ipAddress: null, userAgent: "system:billing" },
      });
    }
  }

  try {
    await prisma.webhookEvent.create({
      data: { id: event.event_id, provider: "PADDLE", type: event.event_type, occurredAt: new Date(event.occurred_at) },
    });
  } catch (err) {
    // A concurrent delivery of the same event finished first. Syncing is idempotent, so that's fine.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return "duplicate";
    throw err;
  }
  return result;
}

async function resolveSubscriptionOwner(paddleSubscriptionId: string, transactionId?: string): Promise<string | null> {
  const known = await prisma.subscription.findUnique({ where: { paddleSubscriptionId }, select: { userId: true } });
  if (known) return known.userId;
  if (!transactionId) return null; // An update arrived before created. The created event will sync the full current state.
  const checkout = await prisma.billingCheckout.findUnique({ where: { transactionId }, select: { userId: true } });
  return checkout?.userId ?? null;
}

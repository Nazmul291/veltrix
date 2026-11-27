/**
 * Promotes a user to SUPER_ADMIN. CLI only: no web setup page exists.
 *
 * Users sign in with NazmulCodes Auth, so this works by the central user ID,
 * never by email. Central sign-ups can have unverified emails, so promoting
 * by email could hand admin to someone who registered your address first.
 *
 *   1. Sign in to Veltrix once with NazmulCodes.
 *   2. npm run admin:bootstrap -- --list                  (find your central ID)
 *   3. npm run admin:bootstrap -- --central-id <id>       (confirm and promote)
 *
 * Refuses to run once a SUPER_ADMIN exists, unless you pass --force.
 * In non-interactive shells, pass --yes to skip the confirmation.
 */
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { writeAuditLog } from "~/services/audit.server";
import { prisma } from "~/services/db.server";

const CLI_CONTEXT = { ipAddress: null, userAgent: "cli:bootstrap-admin" };

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

async function list() {
  const users = await prisma.user.findMany({
    where: { centralUserId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { centralUserId: true, email: true, createdAt: true, adminRole: { select: { role: true } } },
  });
  if (users.length === 0) {
    console.log("No users yet. Sign in to Veltrix once with NazmulCodes, then run this again.");
    return;
  }
  console.log("Most recent users (newest first):\n");
  for (const u of users) {
    console.log(`  ${u.centralUserId}  ${u.createdAt.toISOString().slice(0, 16)}Z  ${u.email}${u.adminRole ? `  [${u.adminRole.role}]` : ""}`);
  }
  console.log("\nPromote with: npm run admin:bootstrap -- --central-id <id>");
}

async function main() {
  const { values } = parseArgs({
    options: {
      "central-id": { type: "string" },
      list: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
  });

  if (values.list) return list();

  const centralUserId = values["central-id"]?.trim();
  if (!centralUserId) throw new Error("Usage: npm run admin:bootstrap -- --list | --central-id <id> [--yes] [--force]");

  const existingSuper = await prisma.adminRole.count({ where: { role: "SUPER_ADMIN" } });
  if (existingSuper > 0 && !values.force) {
    throw new Error(`A SUPER_ADMIN already exists (${existingSuper}). Bootstrap has already run. Use --force only to recover a locked-out instance.`);
  }

  const user = await prisma.user.findUnique({
    where: { centralUserId },
    select: { id: true, email: true, name: true, createdAt: true, adminRole: { select: { role: true } } },
  });
  if (!user) throw new Error("No Veltrix user with that central ID. Sign in once with NazmulCodes first, then use --list.");
  if (user.adminRole?.role === "SUPER_ADMIN") {
    console.log(`${user.email} is already a SUPER_ADMIN. Nothing to do.`);
    return;
  }

  console.log(`\n  Central ID: ${centralUserId}\n  Email:      ${user.email}\n  Name:       ${user.name ?? "-"}\n  First seen: ${user.createdAt.toISOString()}\n`);
  if (!values.yes) {
    if (!process.stdin.isTTY) throw new Error("Not an interactive shell. Re-run with --yes after checking the details above.");
    if (!(await confirm("Promote this account to SUPER_ADMIN? [y/N] "))) {
      console.log("Cancelled.");
      return;
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.adminRole.upsert({
      where: { userId: user.id },
      create: { userId: user.id, role: "SUPER_ADMIN" },
      update: { role: "SUPER_ADMIN" },
    });
    await writeAuditLog(tx, {
      actorId: null,
      action: "admin.bootstrap",
      targetType: "User",
      targetId: user.id,
      metadata: { centralUserId, forced: Boolean(values.force) },
      context: CLI_CONTEXT,
    });
  });

  console.log(`✓ ${user.email} is now SUPER_ADMIN. Configure providers at /admin/providers.`);
}

main()
  .catch((err: unknown) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

/**
 * Creates the first SUPER_ADMIN. CLI only: no web setup page exists, so there's
 * no window where someone else could claim the instance first.
 *
 *   npm run admin:bootstrap -- --email you@company.com
 *
 * - The password is prompted without echo, or read from stdin when piped
 *   (for CI and `fly ssh console`). It's never taken as an argument, because
 *   arguments end up in shell history and `ps`.
 * - If the email already has an account, the user is promoted and their password is kept.
 * - Refuses to run once a SUPER_ADMIN exists, unless you pass --force.
 *   Add further admins from the admin panel, not with this script.
 */
import { parseArgs } from "node:util";
import { emailSchema, newPasswordSchema } from "~/lib/schemas/auth";
import { writeAuditLog } from "~/services/audit.server";
import { prisma } from "~/services/db.server";
import { hashPassword } from "~/services/password.server";

const CLI_CONTEXT = { ipAddress: null, userAgent: "cli:bootstrap-admin" };

function promptHidden(question: string): Promise<string> {
  const { stdin, stdout } = process;
  return new Promise((resolve, reject) => {
    let buf = "";
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n" || c === "\u0004") return (cleanup(), resolve(buf));
        if (c === "\u0003") return (cleanup(), reject(new Error("Aborted")));
        if (c === "\u007f" || c === "\b") buf = buf.slice(0, -1);
        else buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

async function readPiped(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.split(/\r?\n/)[0] ?? "";
}

async function askNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readPiped();
  const first = await promptHidden("New password (min 12 chars): ");
  const second = await promptHidden("Repeat password: ");
  if (first !== second) throw new Error("Passwords do not match.");
  return first;
}

async function main() {
  const { values } = parseArgs({
    options: { email: { type: "string" }, name: { type: "string" }, force: { type: "boolean", default: false } },
  });

  const email = emailSchema.safeParse(values.email ?? "");
  if (!email.success) throw new Error("Usage: npm run admin:bootstrap -- --email you@company.com [--name \"Your Name\"] [--force]");

  const existingSuper = await prisma.adminRole.count({ where: { role: "SUPER_ADMIN" } });
  if (existingSuper > 0 && !values.force) {
    throw new Error(`A SUPER_ADMIN already exists (${existingSuper}). Bootstrap has already run. Use --force only to recover a locked-out instance.`);
  }

  const user = await prisma.user.findUnique({
    where: { email: email.data },
    select: { id: true, passwordHash: true, adminRole: { select: { role: true } } },
  });

  if (user?.adminRole?.role === "SUPER_ADMIN") {
    console.log(`${email.data} is already a SUPER_ADMIN. Nothing to do.`);
    return;
  }

  // Ask for a password only when the account doesn't have one yet.
  let passwordHash: string | null = null;
  if (!user?.passwordHash) {
    const pw = newPasswordSchema.safeParse(await askNewPassword());
    if (!pw.success) throw new Error(pw.error.issues[0]?.message ?? "Invalid password");
    passwordHash = await hashPassword(pw.data);
  }

  const result = await prisma.$transaction(async (tx) => {
    const u = user
      ? passwordHash
        ? await tx.user.update({ where: { id: user.id }, data: { passwordHash }, select: { id: true } })
        : { id: user.id }
      : await tx.user.create({ data: { email: email.data, name: values.name ?? null, passwordHash }, select: { id: true } });

    await tx.adminRole.upsert({
      where: { userId: u.id },
      create: { userId: u.id, role: "SUPER_ADMIN" },
      update: { role: "SUPER_ADMIN" },
    });

    await writeAuditLog(tx, {
      actorId: null,
      action: "admin.bootstrap",
      targetType: "User",
      targetId: u.id,
      metadata: { email: email.data, createdUser: !user, forced: Boolean(values.force) },
      context: CLI_CONTEXT,
    });
    return { userId: u.id, created: !user };
  });

  console.log(`✓ ${email.data} is now SUPER_ADMIN (${result.created ? "new account" : "existing account promoted"}).`);
  console.log("  Sign in at /login, then configure providers at /admin/providers.");
}

main()
  .catch((err: unknown) => {
    console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

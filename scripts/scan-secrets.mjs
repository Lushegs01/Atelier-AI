import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync } from "node:fs";
import { resolve, extname } from "node:path";

// Source-only heuristic scanner. It never prints the matching secret material.
// Enable hosted repository secret protection as a separate release requirement.
const root = resolve(import.meta.dirname, "..");
const paths = [
  ...new Set(
    execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root,
      encoding: "utf8",
    })
      .split("\0")
      .filter(Boolean),
  ),
];
const binary = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".ico",
  ".woff",
  ".woff2",
  ".mp4",
  ".pdf",
  ".zip",
  ".gz",
]);
const findings = [];
let scanned = 0;
const rules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ["Paystack credential", /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
  ["API secret", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}\b/g],
  ["GitHub token", /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  [
    "literal server credential",
    /\b(?:FASHN_API_KEY|PAYSTACK_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|INNGEST_SIGNING_KEY|CRON_SECRET)\s*[:=]\s*["']([^"'\r\n]{16,})["']/g,
  ],
];
for (const path of paths) {
  const absolute = resolve(root, path);
  let stat;
  try {
    stat = lstatSync(absolute);
  } catch {
    continue;
  }
  if (!stat.isFile() || binary.has(extname(path).toLowerCase()) || stat.size > 2_000_000) continue;
  if (/(^|\/)\.env(?:\.|$)/.test(path) && !path.endsWith(".env.example"))
    findings.push({ path, line: 1, rule: "tracked environment file" });
  const source = readFileSync(absolute, "utf8");
  if (source.includes("\0")) continue;
  scanned++;
  for (const [name, pattern] of rules) {
    for (const match of source.matchAll(pattern)) {
      // Synthetic fixtures are intentionally named. This exemption is not a guarantee.
      if (/fixture|example|placeholder|synthetic|your[_-]/i.test(match[0])) continue;
      findings.push({ path, line: source.slice(0, match.index).split("\n").length, rule: name });
    }
  }
  for (const match of source.matchAll(
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  )) {
    try {
      const payload = JSON.parse(Buffer.from(match[0].split(".")[1], "base64url").toString("utf8"));
      if (payload.role === "service_role")
        findings.push({
          path,
          line: source.slice(0, match.index).split("\n").length,
          rule: "Supabase service-role JWT",
        });
    } catch {
      /* Not a JWT; no content is emitted. */
    }
  }
}
if (findings.length) {
  for (const finding of findings)
    process.stderr.write(`${finding.path}:${finding.line}: ${finding.rule}\n`);
  process.stderr.write(
    `Secret scan failed: ${findings.length} possible credential(s). No matching values were printed.\n`,
  );
  process.exitCode = 1;
} else
  process.stdout.write(
    `Secret scan passed: ${scanned} source files checked. Heuristic scan; hosted secret protection and manual review remain required.\n`,
  );

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/deploy-quiknation-paperclip.sh", import.meta.url));
const temporaryPaths: string[] = [];
afterEach(() => { for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true }); });

function run(options: { failFetch?: boolean; failDeploy?: boolean; url?: string } = {}) {
  const temp = mkdtempSync(join(tmpdir(), "paperclip-deploy-test-"));
  temporaryPaths.push(temp);
  const bin = join(temp, "bin");
  const runner = join(temp, "runner");
  mkdirSync(bin); mkdirSync(runner);
  writeFileSync(join(bin, "aws"), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
if (args[0] !== 'secretsmanager' || args[1] !== 'get-secret-value') process.exit(91);
const name = args[args.indexOf('--secret-id') + 1];
fs.appendFileSync(process.env.CALL_LOG, name + '\\n');
if (process.env.FAIL_FETCH === '1') process.exit(23);
const value = 'TEST_ONLY_' + name;
process.stdout.write(args.includes('--query') ? value + '\\n' : JSON.stringify({ SecretString: value }));
`, { mode: 0o700 });
  writeFileSync(join(bin, "pnpm"), `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('--secrets-file') + 1];
const bindings = JSON.parse(fs.readFileSync(file, 'utf8'));
if ((fs.statSync(file).mode & 0o777) !== 0o600) process.exit(92);
if (bindings.AWS_ACCESS_KEY_ID !== 'TEST_ONLY_quik-nation/quiknation/paperclip/R2_ACCESS_KEY_ID') process.exit(93);
if (bindings.AWS_SECRET_ACCESS_KEY !== 'TEST_ONLY_quik-nation/quiknation/paperclip/R2_SECRET_ACCESS_KEY') process.exit(94);
if (process.env.CLOUDFLARE_API_TOKEN !== 'TEST_ONLY_quik-nation/quiknation/production/CLOUDFLARE_API_TOKEN') process.exit(95);
fs.writeFileSync(process.env.DEPLOY_RECEIPT, JSON.stringify({ args, bindings: Object.keys(bindings) }));
process.exit(process.env.FAIL_DEPLOY === '1' ? 24 : 0);
`, { mode: 0o700 });
  const result = spawnSync("/bin/bash", [script], {
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/opt/homebrew/bin:/usr/bin:/bin`,
      RUNNER_TEMP: runner, CALL_LOG: join(temp, "calls"), DEPLOY_RECEIPT: join(temp, "receipt"),
      PAPERCLIP_AUTH_PUBLIC_BASE_URL: options.url ?? "https://paperclip.example",
      FAIL_FETCH: options.failFetch ? "1" : "0", FAIL_DEPLOY: options.failDeploy ? "1" : "0",
    },
    encoding: "utf8",
  });
  expect(`${result.stdout}${result.stderr}`).not.toContain("TEST_ONLY_");
  expect(readdirSync(runner)).toEqual([]);
  return { result, temp };
}

describe("Paperclip deploy script using fake executables only", () => {
  it("maps only the approved R2 names, keeps values out of output and deletes temporary material", () => {
    const { result, temp } = run();
    expect(result.status).toBe(0);
    expect(readFileSync(join(temp, "calls"), "utf8").trim().split("\n")).toEqual([
      "quik-nation/quiknation/paperclip/DATABASE_URL", "quik-nation/quiknation/paperclip/BETTER_AUTH_SECRET",
      "quik-nation/quiknation/paperclip/PAPERCLIP_AGENT_JWT_SECRET", "quik-nation/quiknation/paperclip/PAPERCLIP_SECRETS_MASTER_KEY",
      "quik-nation/quiknation/paperclip/R2_ACCESS_KEY_ID", "quik-nation/quiknation/paperclip/R2_SECRET_ACCESS_KEY",
      "quik-nation/quiknation/production/CLOUDFLARE_API_TOKEN",
    ]);
    const receipt = JSON.parse(readFileSync(join(temp, "receipt"), "utf8"));
    expect(receipt.args.slice(0, 5)).toEqual(["exec", "wrangler", "deploy", "--config", "wrangler.paperclip.jsonc"]);
    expect(receipt.bindings).toHaveLength(6);
  });

  it("fails closed and removes temporary files when Secrets Manager fails", () => { expect(run({ failFetch: true }).result.status).not.toBe(0); });
  it("removes temporary files when Wrangler fails", () => { expect(run({ failDeploy: true }).result.status).toBe(24); });
  it.each(["http://paperclip.example", "https://user:password@paperclip.example", "invalid-url"])("rejects invalid public URL %s before fetching", (url) => {
    const { result, temp } = run({ url });
    expect(result.status).not.toBe(0);
    expect(readdirSync(temp)).not.toContain("calls");
  });
});

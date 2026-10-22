import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.ADMIN_PASSWORD = "correct horse";
process.env.BASE_URL = "http://localhost:8080";
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "bank-"));
process.env.ATTESTATION_ENABLED = "1";
const { SingleUserProvider, attestOnly } = await import("../src/auth.ts");
const { Store } = await import("../src/store.ts");
const { createServer } = await import("../src/mcp.ts");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const fakeRes = () => {
  const out = { status: 0, body: "" };
  const res = { status: (s: number) => ((out.status = s), res), type: () => res, send: (b: string) => ((out.body = b), res) };
  return { out, res: res as unknown as import("express").Response };
};

async function signIn(scopes: string[]) {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json"));
  const provider = new SingleUserProvider(store);
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/cb"], client_name: "Verifier", token_endpoint_auth_method: "none" });
  const { out, res } = fakeRes();
  await provider.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/cb", scopes }, res);
  const requestId = /name="request" value="([^"]+)"/.exec(out.body)![1]!;
  const ok = provider.completeLogin(requestId, "correct horse", "1.2.3.4");
  assert.ok("redirect" in ok);
  const tokens = await provider.exchangeAuthorizationCode(client, new URL(ok.redirect).searchParams.get("code")!);
  return { provider, client, tokens, page: out.body };
}

async function toolNames(opts: { attestOnly?: boolean }) {
  const server = createServer(opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name).sort();
}

test("only bank:attest without bank:read is attestation-only", () => {
  assert.equal(attestOnly(["bank:attest"]), true);
  assert.equal(attestOnly(["bank:attest", "bank:read"]), false);
  assert.equal(attestOnly(["bank:read"]), false);
  assert.equal(attestOnly([]), false);
});

test("the sign-in page says which access is being granted", async () => {
  assert.match((await signIn(["bank:attest"])).page, /cannot see your balances, transactions/);
  assert.match((await signIn(["bank:read"])).page, /<b>all<\/b> balances and transactions/);
  assert.match((await signIn([])).page, /<b>all<\/b> balances and transactions/);
});

test("an attestation-only token sees attest_account and nothing else", async () => {
  assert.deepEqual(await toolNames({ attestOnly: true }), ["attest_account"]);
  const full = await toolNames({});
  assert.ok(full.includes("get_transactions") && full.includes("attest_account"));
});

test("a refresh cannot widen an attestation-only token", async () => {
  const { provider, client, tokens } = await signIn(["bank:attest"]);
  const { scopes } = await provider.verifyAccessToken(tokens.access_token);
  assert.deepEqual(scopes, ["bank:attest"]);
  await assert.rejects(provider.exchangeRefreshToken(client, tokens.refresh_token!, ["bank:read"]), /scope/);
  const again = await provider.exchangeRefreshToken(client, tokens.refresh_token!);
  assert.deepEqual((await provider.verifyAccessToken(again.access_token)).scopes, ["bank:attest"]);
});

test("after a wrong password the sign-in page still says attestation only", async () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "bank-")), "store.json"));
  const provider = new SingleUserProvider(store);
  const client = await provider.clientsStore.registerClient!({ redirect_uris: ["https://claude.ai/cb"], client_name: "Verifier", token_endpoint_auth_method: "none" });
  const { out, res } = fakeRes();
  await provider.authorize(client, { codeChallenge: "c", redirectUri: "https://claude.ai/cb", scopes: ["bank:attest"] }, res);
  const requestId = /name="request" value="([^"]+)"/.exec(out.body)![1]!;
  const wrong = provider.completeLogin(requestId, "nope", "1.2.3.4");
  assert.ok("error" in wrong && wrong.requestId);
  const page = provider.loginPageFor(wrong.requestId, wrong.error);
  assert.match(page, /cannot see your balances, transactions/);
  assert.match(page, /Wrong password/);
});

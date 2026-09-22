import { test } from "node:test";
import assert from "node:assert/strict";

delete process.env.HOST;
const fallback = await import("../src/config.ts");

test("binds every interface by default, so container platforms keep working", () => {
  assert.equal(fallback.config.host, "0.0.0.0");
});

test("HOST binds one interface, for a proxy or tunnel in front", async () => {
  process.env.HOST = "127.0.0.1";
  const { config } = await import("../src/config.ts?host=set");
  assert.equal(config.host, "127.0.0.1");
});

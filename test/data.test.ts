import { test } from "node:test";
import assert from "node:assert/strict";
import { simplifyTransaction, simplifyTransactions, simplifyBalances } from "../src/data.ts";
import type { Transaction } from "../src/enablebanking.ts";

test("debits are negative and take the creditor as counterparty", () => {
  const t = simplifyTransaction({
    entry_reference: "abc",
    transaction_amount: { amount: "123.45", currency: "DKK" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    booking_date: "2026-09-01",
    creditor: { name: "Netto" },
    remittance_information: ["Card 1234 Netto Copenhagen"],
  });
  assert.equal(t.amount, -123.45);
  assert.equal(t.counterparty, "Netto");
  assert.equal(t.description, "Card 1234 Netto Copenhagen");
  assert.equal(t.id, "abc");
});

test("credits are positive and take the debtor", () => {
  const t = simplifyTransaction({
    transaction_id: "x",
    transaction_amount: { amount: "10000", currency: "DKK" },
    credit_debit_indicator: "CRDT",
    status: "BOOK",
    booking_date: "2026-09-01",
    debtor: { name: "Acme Ltd" },
  });
  assert.equal(t.amount, 10000);
  assert.equal(t.counterparty, "Acme Ltd");
  assert.equal(t.description, undefined);
});

test("booked prefers CLBD, then ITBD; available is XPCD", () => {
  const b = simplifyBalances([
    { balance_type: "XPCD", balance_amount: { amount: "1500.00", currency: "DKK" } },
    { balance_type: "ITBD", balance_amount: { amount: "-500000.00", currency: "DKK" } },
  ]);
  assert.equal(b.booked, -500000);
  assert.equal(b.available, 1500);
  const c = simplifyBalances([
    { balance_type: "ITBD", balance_amount: { amount: "1", currency: "EUR" } },
    { balance_type: "CLBD", balance_amount: { amount: "2", currency: "EUR" } },
  ]);
  assert.equal(c.booked, 2);
  assert.equal(c.available, undefined);
});

test("a bank that reports only ITAV still yields a booked balance (#1)", () => {
  const b = simplifyBalances([{ balance_type: "ITAV", name: "Available balance calculated in the course of the business day", balance_amount: { amount: "1234.50", currency: "EUR" } }]);
  assert.equal(b.booked, 1234.5);
  assert.equal(b.booked_type, "ITAV");
  assert.equal(b.available, undefined, "the single balance is not reported twice");
});

const coffee: Transaction = {
  transaction_amount: { amount: "45.00", currency: "DKK" },
  credit_debit_indicator: "DBIT",
  status: "BOOK",
  booking_date: "2026-09-20",
  creditor: { name: "Kaffebar" },
};

test("the id survives a refetch, even when transaction_id changes", () => {
  const first = simplifyTransaction({ ...coffee, transaction_id: "one" });
  const second = simplifyTransaction({ ...coffee, transaction_id: "two" });
  assert.equal(first.id, second.id);
  assert.notEqual(first.id, "one");
  const dearer = simplifyTransaction({ ...coffee, transaction_amount: { amount: "46.00", currency: "DKK" } });
  assert.notEqual(dearer.id, first.id);
});

test("two identical purchases on the same day keep separate ids", () => {
  const [a, b] = simplifyTransactions([coffee, { ...coffee }]);
  assert.notEqual(a.id, b.id);
  assert.equal(b.id, `${a.id}#2`);
});

test("entry_reference is the id and never gets a counter", () => {
  const [a, b] = simplifyTransactions([{ ...coffee, entry_reference: "abc" }, { ...coffee, entry_reference: "abc" }]);
  assert.equal(a.id, "abc");
  assert.equal(b.id, "abc");
});

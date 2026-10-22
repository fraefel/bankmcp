import { test } from "node:test";
import assert from "node:assert/strict";
import { findOwnTransfers, matchesQuery, simplifyTransaction, simplifyTransactions, simplifyBalances, totalsByMonth, type AccountTransaction } from "../src/data.ts";
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

test("debits carry the creditor account, credits the debtor account", () => {
  const out = simplifyTransaction({
    transaction_amount: { amount: "50", currency: "EUR" },
    credit_debit_indicator: "DBIT",
    status: "BOOK",
    booking_date: "2026-09-01",
    creditor_account: { iban: "DK5000400440116243" },
    debtor_account: { iban: "DK0000000000000000" },
  });
  assert.equal(out.counterparty_account, "DK5000400440116243");
});

const tx = (amount: number, description: string, extra: Partial<AccountTransaction> = {}): AccountTransaction => ({
  id: `${amount}-${description}`,
  date: "2026-09-10",
  amount,
  currency: "EUR",
  description,
  status: "BOOK",
  account_uid: "a",
  ...extra,
});

test("search matches whole tokens only", () => {
  assert.ok(matchesQuery(tx(250, "Acme invoice 1044"), "1044"));
  assert.ok(matchesQuery(tx(250, "INV-1044/part 2"), "1044"));
  assert.ok(!matchesQuery(tx(180, "Acme invoice 1044B"), "1044"));
  assert.ok(!matchesQuery(tx(180, "Ref 21044"), "1044"));
  assert.ok(matchesQuery(tx(-90, "card", { counterparty: "HOMEPOWER AB" }), "homepower"));
  assert.ok(!matchesQuery(tx(-90, "card"), "  "));
});

test("transfers between own accounts are found by account number or by opposite legs", () => {
  const byIban = tx(-500, "to savings", { counterparty_account: "DK50 0040 0440 1162 43" });
  const out = tx(-300, "card repayment", { date: "2026-09-10" });
  const into = tx(300, "payment received", { account_uid: "card", date: "2026-09-11" });
  const sameAccount = tx(300, "refund", { date: "2026-09-10" });
  const groceries = tx(-42, "Netto");
  const found = findOwnTransfers([byIban, out, into, sameAccount, groceries], ["DK5000400440116243"]);
  assert.deepEqual([...found].sort((x, y) => x.amount - y.amount), [byIban, out, into]);
});

test("monthly totals leave out transfers and split by month and currency", () => {
  const list = [
    tx(-100, "a", { date: "2026-08-03" }),
    tx(40, "refund", { date: "2026-08-20" }),
    tx(-500, "transfer", { date: "2026-08-21" }),
    tx(-25.5, "b", { date: "2026-09-01" }),
    tx(-10, "c", { date: "2026-09-02", currency: "DKK" }),
  ];
  const rows = totalsByMonth(list, new Set([list[2]!]));
  assert.deepEqual(rows, [
    { month: "2026-08", currency: "EUR", money_in: 40, money_out: -100, net: -60, count: 2 },
    { month: "2026-09", currency: "DKK", money_in: 0, money_out: -10, net: -10, count: 1 },
    { month: "2026-09", currency: "EUR", money_in: 0, money_out: -25.5, net: -25.5, count: 1 },
  ]);
});

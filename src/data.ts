// Shapes the API responses into what an assistant actually needs: signed
// amounts, one counterparty field, one description field, and a booked vs
// available balance instead of a list of ISO balance codes.
import { createHash } from "node:crypto";
import type { Balance, Transaction } from "./enablebanking.ts";
import type { StoredAccount, StoredSession } from "./store.ts";

export interface SimpleTransaction {
  id: string;
  date: string;
  value_date?: string;
  /** Negative = money out. */
  amount: number;
  currency: string;
  counterparty?: string;
  /** The other side's IBAN or account number, when the bank reports it. */
  counterparty_account?: string;
  description?: string;
  status: string;
  balance_after?: number;
  merchant_category_code?: string;
}

/** A stable id for a transaction the bank gives no entry_reference for: a hash of the fields that identify it.
 * transaction_id is deliberately not used. Enable Banking documents that it can change when the list is fetched
 * again, which would make a watch fire twice for the same transaction. */
function fingerprint(t: Transaction, signed: number, counterparty?: string, description?: string): string {
  const fields = [
    t.booking_date,
    t.value_date,
    t.transaction_date,
    signed,
    t.transaction_amount.currency,
    counterparty,
    description,
    t.balance_after_transaction?.amount,
  ];
  return createHash("sha256").update(fields.map((f) => f ?? "").join("\u001f")).digest("hex").slice(0, 16);
}

export function simplifyTransaction(t: Transaction): SimpleTransaction {
  const signed = Number(t.transaction_amount.amount) * (t.credit_debit_indicator === "DBIT" ? -1 : 1);
  const counterparty = (t.credit_debit_indicator === "DBIT" ? t.creditor?.name : t.debtor?.name) || undefined;
  const description = [t.remittance_information?.join(" "), t.bank_transaction_code?.description, t.note].find((s) => s && s.trim()) || undefined;
  const other = t.credit_debit_indicator === "DBIT" ? t.creditor_account : t.debtor_account;
  return {
    id: t.entry_reference || fingerprint(t, signed, counterparty, description),
    date: t.booking_date || t.value_date || t.transaction_date || "",
    value_date: t.value_date && t.value_date !== t.booking_date ? t.value_date : undefined,
    amount: round2(signed),
    currency: t.transaction_amount.currency,
    counterparty,
    counterparty_account: other?.iban || other?.other?.identification || undefined,
    description: description && description !== counterparty ? description : undefined,
    status: t.status,
    balance_after: t.balance_after_transaction ? round2(Number(t.balance_after_transaction.amount)) : undefined,
    merchant_category_code: t.merchant_category_code,
  };
}

/** Simplifies a whole list and keeps transactions without an entry_reference apart, even when two of them are
 * identical: same day, same amount, same shop. Their fingerprints are equal, so the later ones get a counter.
 * Use this instead of mapping simplifyTransaction over a list. */
export function simplifyTransactions(list: Transaction[]): SimpleTransaction[] {
  const counts = new Map<string, number>();
  return list.map((t) => {
    const simple = simplifyTransaction(t);
    if (t.entry_reference) return simple;
    const n = (counts.get(simple.id) ?? 0) + 1;
    counts.set(simple.id, n);
    return n === 1 ? simple : { ...simple, id: `${simple.id}#${n}` };
  });
}

export interface SimpleBalances {
  /** Booked (cleared) balance: CLBD, or ITBD when the bank gives no CLBD. This is the number to use for net worth. */
  booked?: number;
  /** Which balance type `booked` came from (CLBD, ITBD, CLAV, ITAV, XPCD, …). */
  booked_type?: string;
  /** Available to spend, when the bank reports it (XPCD/OTHR "available"). Credit accounts often report the available credit here. */
  available?: number;
  currency?: string;
  reference_date?: string;
  all: Array<{ type: string; name?: string; amount: number; reference_date?: string }>;
}

export function simplifyBalances(balances: Balance[]): SimpleBalances {
  const byType = (types: string[]) => balances.find((b) => types.includes(b.balance_type));
  // Preference order: closing booked, interim booked, closing available, interim
  // available, expected, then whatever the bank sent. Some banks (Revolut, for
  // one) report a single ITAV balance and nothing else; an account must never
  // vanish from a total because of the label its bank chose.
  const booked = byType(["CLBD"]) ?? byType(["ITBD"]) ?? byType(["CLAV"]) ?? byType(["ITAV"]) ?? byType(["XPCD"]) ?? balances[0];
  const available = byType(["XPCD"]) ?? balances.find((b) => /avail/i.test(b.name ?? "") || /avail/i.test(b.balance_type));
  return {
    booked: booked ? round2(Number(booked.balance_amount.amount)) : undefined,
    booked_type: booked?.balance_type,
    available: available && available !== booked ? round2(Number(available.balance_amount.amount)) : undefined,
    currency: (booked ?? balances[0])?.balance_amount.currency,
    reference_date: (booked ?? balances[0])?.reference_date,
    all: balances.map((b) => ({ type: b.balance_type, name: b.name, amount: round2(Number(b.balance_amount.amount)), reference_date: b.reference_date })),
  };
}

const normalizeId = (s: string) => s.replace(/\s+/g, "").toUpperCase();

/** True when `query` appears in the counterparty or description as a whole token, case-insensitive:
 * "1044" matches "Invoice 1044" and "INV-1044" but not "1044B" or "21044". */
export function matchesQuery(t: SimpleTransaction, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  for (const field of [t.counterparty, t.description]) {
    const text = field?.toLowerCase();
    if (!text) continue;
    for (let i = text.indexOf(q); i !== -1; i = text.indexOf(q, i + 1)) {
      const before = text[i - 1];
      const after = text[i + q.length];
      if ((before === undefined || !/[\p{L}\p{N}]/u.test(before)) && (after === undefined || !/[\p{L}\p{N}]/u.test(after))) return true;
    }
  }
  return false;
}

export interface AccountTransaction extends SimpleTransaction {
  account_uid: string;
}

/**
 * Finds transfers between the owner's own accounts, card repayments to a connected card included. A transaction is a
 * transfer when its counterparty account is one of `ownIds`, or when another connected account has the opposite
 * amount in the same currency within two days. Each transaction pairs at most once. Returns both legs of each.
 */
export function findOwnTransfers(list: AccountTransaction[], ownIds: string[]): Set<AccountTransaction> {
  const own = new Set(ownIds.map(normalizeId));
  const transfers = new Set<AccountTransaction>();
  for (const t of list) if (t.counterparty_account && own.has(normalizeId(t.counterparty_account))) transfers.add(t);
  const dayMs = 86_400_000;
  const outs = list.filter((t) => t.amount < 0 && !transfers.has(t));
  const ins = list.filter((t) => t.amount > 0 && !transfers.has(t));
  for (const o of outs) {
    const match = ins.find(
      (i) =>
        !transfers.has(i) &&
        i.account_uid !== o.account_uid &&
        i.currency === o.currency &&
        i.amount === -o.amount &&
        Math.abs(Date.parse(i.date) - Date.parse(o.date)) <= 2 * dayMs,
    );
    if (match) {
      transfers.add(o);
      transfers.add(match);
    }
  }
  return transfers;
}

export interface MonthTotals {
  month: string;
  currency: string;
  money_in: number;
  money_out: number;
  net: number;
  count: number;
}

/** Money in and out per calendar month and currency, leaving out the transactions in `exclude`. */
export function totalsByMonth(list: AccountTransaction[], exclude: Set<AccountTransaction>): MonthTotals[] {
  const rows = new Map<string, MonthTotals>();
  for (const t of list) {
    if (exclude.has(t) || !t.date) continue;
    const month = t.date.slice(0, 7);
    const key = `${month} ${t.currency}`;
    const row = rows.get(key) ?? { month, currency: t.currency, money_in: 0, money_out: 0, net: 0, count: 0 };
    if (t.amount > 0) row.money_in += t.amount;
    else row.money_out += t.amount;
    row.count += 1;
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((r) => ({ ...r, money_in: round2(r.money_in), money_out: round2(r.money_out), net: round2(r.money_in + r.money_out) }))
    .sort((a, b) => (a.month === b.month ? a.currency.localeCompare(b.currency) : a.month.localeCompare(b.month)));
}

export function describeAccount(a: StoredAccount, s?: StoredSession) {
  return {
    uid: a.uid,
    label: a.label ?? null,
    name: a.name ?? a.product ?? null,
    product: a.product ?? null,
    iban: a.iban ?? a.other_id ?? null,
    currency: a.currency,
    type: a.cash_account_type ?? null,
    bank: s ? `${s.bank.name} (${s.bank.country})` : null,
    consent_valid_until: s?.valid_until ?? null,
    consent_days_left: s ? daysLeft(s.valid_until) : null,
  };
}

export function daysLeft(iso: string): number {
  return Math.floor((Date.parse(iso) - Date.now()) / 86_400_000);
}

export function isoDate(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number): string {
  return isoDate(new Date(Date.now() - n * 86_400_000));
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

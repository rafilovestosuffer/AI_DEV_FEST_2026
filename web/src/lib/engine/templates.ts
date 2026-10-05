/**
 * Reviewed template library — ported from Sathi llm/templates/<locale>/*.txt.
 *
 * Templates are pre-reviewed user-facing strings (both locales). All values
 * arrive pre-formatted by engine/formatting.ts, so a template never computes
 * anything. These are the fail-closed fallbacks for the chat orchestrator.
 */

import type { Locale } from "./formatting";
import { toBanglaDigits as bnDigits, formatTaka, formatProbability, formatDays, formatDate } from "./formatting";

export type TemplateName =
  | "greeting"
  | "safe_spend"
  | "forecast_risk"
  | "forecast_safe"
  | "cashout_audit"
  | "goal_plan"
  | "general_help"
  | "general_refusal"
  | "summary_income_spend"
  | "summary_largest_week"
  | "summary_fees"
  | "summary_buffer"
  | "summary_low_data";

const TEMPLATES: Record<Locale, Record<TemplateName, string>> = {
  bn: {
    greeting:
      "আস-সালামু আলাইকুম! আমি সাথী — আপনার AI আর্থিক বন্ধু। আমি আপনার নিরাপদ খরচ, ভবিষ্যতের পূর্বাভাস, ক্যাশ-আউট ফি সাশ্রয় ও সঞ্চয় পরিকল্পনায় সাহায্য করতে পারি।",
    safe_spend:
      "আপনার ওয়ালেটের বর্তমান ব্যালেন্স {balance}। আসন্ন বিল বিবেচনায় নিরাপদে খরচ করতে পারবেন {safe_spend} — প্রতিদিন প্রায় {daily_budget}।",
    forecast_risk:
      "সামনের {horizon} দিনে টানাটানির সম্ভাবনা প্রায় {shortfall_prob}। বিশেষ করে {trough_date} নাগাদ সতর্ক থাকা ভালো।",
    forecast_safe:
      "সামনের {horizon} দিনে কোনো টানাটানির সম্ভাবনা কম। এই সময়ের সর্বনিম্ন ব্যালেন্স প্রায় {min_balance} হতে পারে, সম্ভাব্য সময় {trough_date} নাগাদ।",
    cashout_audit:
      "আপনি এজেন্ট থেকে ক্যাশ-আউট না করে ডিজিটাল পেমেন্ট করলে আনুমানিক {savings} ফি বাঁচাতে পারতেন।",
    goal_plan:
      "আপনার {target_amount} লক্ষ্যমাত্রার জন্য {months} মাসে পৌঁছানোর বাস্তবসম্মত পরিকল্পনা তৈরি করা হয়েছে।",
    general_help:
      "আমি আপনাকে সাহায্য করতে পারি: ১. নিরাপদ খরচের সীমা জানতে, ২. আগামী ২১ দিনের আর্থিক পূর্বাভাস দেখতে, ৩. ক্যাশ-আউট ফি কমাতে, এবং ৪. সঞ্চয় লক্ষ্য পরিকল্পনায়।",
    general_refusal:
      "আমি টাকা স্থানান্তর বা ঋণের সিদ্ধান্ত নিতে পারি না। আপনার খরচ, সঞ্চয় ও লেনদেন বুঝতে সাহায্য করতে পারি।",
    summary_income_spend: "গত পূর্ণ মাসে আপনার ওয়ালেটে এসেছে {income}, খরচ হয়েছে {spend}।",
    summary_largest_week: "সবচেয়ে বেশি খরচ হয়েছে {week_date} শুরু হওয়া সপ্তাহে — মোট {amount}।",
    summary_fees: "ক্যাশ-আউট ফি হিসেবে এই সময়ে মোট {fees} গেছে।",
    summary_buffer: "বর্তমান ব্যালেন্স দিয়ে প্রয়োজনীয় খরচ চলতে পারে প্রায় {days} দিন।",
    summary_low_data:
      "আপনার লেনদেনের ইতিহাস এখনো কম — তাই হিসাবগুলো আনুমানিক। কিছুদিন ব্যবহারের পর আরও নির্ভুল হবে।",
  },
  en: {
    greeting:
      "Hello! I am Sathi — your AI financial companion. I can help you with safe spending limits, cash flow forecasting, cash-out fee optimization, and savings planning.",
    safe_spend:
      "Your current wallet balance is {balance}. After upcoming bills, you can safely spend {safe_spend} — about {daily_budget} per day.",
    forecast_risk:
      "There is an estimated {shortfall_prob} probability of liquidity pressure in the next {horizon} days, especially around {trough_date}.",
    forecast_safe:
      "Cash flow is projected to remain stable over the next {horizon} days. The lowest point in the forecast window is approximately {min_balance}, expected around {trough_date}.",
    cashout_audit:
      "You could have saved approximately {savings} in cash-out fees by paying merchants digitally instead of withdrawing from agents.",
    goal_plan:
      "A realistic savings plan has been prepared for your {target_amount} goal over {months} months.",
    general_help:
      "I can assist you with: 1. Calculating safe-to-spend limits, 2. 21-day cash flow forecasting, 3. Reducing cash-out fees, and 4. Smart savings goal planning.",
    general_refusal:
      "I cannot transfer funds or make lending decisions. I can help explain your spending, forecast cash flow, and plan savings goals.",
    summary_income_spend: "Last full month, {income} came into your wallet and {spend} went out.",
    summary_largest_week: "The heaviest spending week started {week_date} — {amount} in total.",
    summary_fees: "Cash-out fees over this period add up to {fees}.",
    summary_buffer: "Your current balance can cover essentials for about {days} days.",
    summary_low_data:
      "Your transaction history is still short, so these numbers are estimates. They sharpen as you keep using the wallet.",
  },
};

/** Render a named template with pre-formatted values. Unknown locale → Bangla. */
export function render(name: TemplateName, locale: Locale = "bn", values: Record<string, string> = {}): string {
  const loc: Locale = locale === "en" ? "en" : "bn";
  return TEMPLATES[loc][name].replace(/\{(\w+)\}/g, (m, key: string) => values[key] ?? m);
}

/* -------- convenience: pre-formatted variable bundles per intent -------- */

export function templateVarsSafeSpend(v: {
  balance: number; safeSpend: number; dailyBudget: number;
}, locale: Locale): Record<string, string> {
  return {
    balance: formatTaka(v.balance, locale),
    safe_spend: formatTaka(v.safeSpend, locale),
    daily_budget: formatTaka(v.dailyBudget, locale),
  };
}

export function templateVarsForecastRisk(v: {
  horizon: number; shortfallProb: number; troughDate: string;
}, locale: Locale): Record<string, string> {
  return {
    horizon: locale === "bn" ? bnDigits(String(v.horizon)) : String(v.horizon),
    shortfall_prob: formatProbability(v.shortfallProb, locale),
    trough_date: v.troughDate,
  };
}

export function templateVarsForecastSafe(v: {
  horizon: number; minBalance: number; troughDate: string;
}, locale: Locale): Record<string, string> {
  return {
    horizon: locale === "bn" ? bnDigits(String(v.horizon)) : String(v.horizon),
    min_balance: formatTaka(v.minBalance, locale),
    trough_date: v.troughDate,
  };
}

export function templateVarsGoal(v: { target: number; months: number }, locale: Locale): Record<string, string> {
  return {
    target_amount: formatTaka(v.target, locale),
    months: locale === "bn" ? bnDigits(String(v.months)) : String(v.months),
  };
}

export function templateVarsIncomeSpend(v: { income: number; spend: number }, locale: Locale): Record<string, string> {
  return {
    income: formatTaka(v.income, locale),
    spend: formatTaka(v.spend, locale),
  };
}

export function templateVarsLargestWeek(v: { weekDate: Date; amount: number }, locale: Locale): Record<string, string> {
  return {
    week_date: formatDate(v.weekDate, locale),
    amount: formatTaka(v.amount, locale),
  };
}

export function templateVarsDays(v: { days: number }, locale: Locale): Record<string, string> {
  return { days: formatDays(v.days, locale) };
}

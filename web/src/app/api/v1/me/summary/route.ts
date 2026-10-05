import { NextRequest } from "next/server";
import {
  userIdFromRequest, ensurePersonaUser, personaTxns, personaOfUser,
  buildEvidence, ok, unauthorized, notFound,
} from "@/lib/server/sathiApi";
import { personaUserForecast } from "@/lib/server/userForecast";
import { getUserInputs, effectiveCashOnHand, behavioralCash } from "@/lib/server/userInputs";
import { ESSENTIALS_PER_DAY_TAKA, THRESHOLDS } from "@/lib/engine/sathiConfig";
import { computeMetrics, monthlyTotals, weeklyOutflows } from "@/lib/engine/metricsEngine";
import { calculateSafeToSpend, upcomingCommitments, modelStatus } from "@/lib/engine/safeToSpend";
import { detectRecurring, estimateCashOnHand } from "@/lib/engine/analytics";
import { categorize, SATHI_CATEGORY_LABELS } from "@/lib/engine/categorizer";
import { formatTaka, formatProbability, formatDays, formatDate, toBanglaDigits } from "@/lib/engine/formatting";
import { render, templateVarsIncomeSpend, templateVarsLargestWeek, templateVarsDays } from "@/lib/engine/templates";
import { cashoutFee } from "@/lib/engine/cashout";

export const dynamic = "force-dynamic";

/**
 * Full summary (reference: GET /v1/me/summary) — metrics + categorizer +
 * safe-to-spend + cash-on-hand + recurring + template-rendered insights,
 * with the evidence block. All money in integer paisa + bn display strings.
 */
export async function GET(req: NextRequest) {
  try {
    const personaId = userIdFromRequest(req);
    if (!personaId) return unauthorized();
    const user = await ensurePersonaUser(personaId).catch(() => null);
    if (!user) return notFound();
    const { txns } = await personaTxns(user.id);

    const anchor = new Date();
    const asOf = anchor.toISOString().slice(0, 10);
    const windowStart = txns.length ? txns[0].timestamp.slice(0, 10) : asOf;
    const balance = estimateCashOnHand(txns, anchor, user.openingBalance, {
      amount: user.salaryAmount, payDay: user.salaryPayDay,
    }).walletBalance;

    const metrics = computeMetrics(txns, balance, ESSENTIALS_PER_DAY_TAKA);
    const confidence =
      metrics.nTransactions < THRESHOLDS.min_history_transactions ||
      metrics.windowDays < THRESHOLDS.min_history_days
        ? "low"
        : "normal";

    // Recurring obligations learned from history only (never persona/config).
    const recurringAll = detectRecurring(txns);
    const recurringOut = recurringAll.filter((r) => r.direction === "out");
    const recurringIn = recurringAll.filter((r) => r.direction === "in");
    const commitments14 = upcomingCommitments(recurringOut, anchor, 14);

    // Physical cash-on-hand: behavioral estimate corrected by any user
    // declaration (POST /v1/me/inputs), decaying at the observed burn.
    const inputs = await getUserInputs(user.id);
    const eff = effectiveCashOnHand(txns, anchor, inputs.cashOnHandTaka, inputs.cashOnHandUpdatedAt);
    const otherLiquid = inputs.otherLiquidTaka ?? 0;
    // Observed trailing cash-out totals (21-day window, same estimator the
    // effective-cash decay uses) — NOT the effective cash figure, which is a
    // different quantity and used to duplicate these fields before the fix.
    const trailingCashout = behavioralCash(txns, anchor);
    const dailyCashBurn = trailingCashout.burnTakaPerDay;
    const trailingCashoutTotal = trailingCashout.trailingTotalTaka;

    // Core safe-to-spend (taka engine -> paisa output) - the RULE baseline,
    // computed over TOTAL liquidity: wallet + effective cash + other liquid.
    const s2s = calculateSafeToSpend({
      walletBalance: balance,
      upcomingCommitments: commitments14,
      dailyEssentials: Math.max(ESSENTIALS_PER_DAY_TAKA, Math.round(metrics.monthlySpend / 30)),
      horizonDays: 14,
      monthlySavingsTarget: 0,
      cashOnHand: eff.cashTaka,
      otherLiquid,
    });
    const liquidity_basis = {
      wallet_balance_paisa: balance * 100,
      cash_on_hand_paisa: eff.cashTaka * 100,
      other_liquid_paisa: otherLiquid * 100,
      total_liquid_paisa: (Math.max(0, balance) + Math.max(0, eff.cashTaka) + Math.max(0, otherLiquid)) * 100,
      cash_source: eff.source,
    };

    // Model-based safe-to-spend (ML handoff): Q_0.10 of the simulated minimum
    // wallet balance before the next income, minus the personal floor. The
    // rule value above is kept alongside as the baseline (summary_service.py).
    const fc = personaUserForecast(user, txns);
    const essentialsPaisa = THRESHOLDS.essentials_per_day_paisa;
    let safeTotalPaisa = s2s.safeToSpendTotal * 100;
    let windowDays = s2s.horizonDays;
    let status: string = s2s.status;
    let statusLabelBn = s2s.statusLabelBn;
    let statusLabelEn = s2s.statusLabelEn;
    let adviceBn = s2s.adviceBn;
    let adviceEn = s2s.adviceEn;
    let method = "rule";
    let shortfallProb: number | null = null;
    let modelVersion: string | null = null;
    if (fc) {
      safeTotalPaisa = fc.safeToSpendPaisa;
      windowDays = fc.windowDays;
      const ms = modelStatus(fc.safeToSpendPaisa, essentialsPaisa, fc.pShortfall);
      status = ms.status;
      statusLabelBn = ms.labelBn;
      statusLabelEn = ms.labelEn;
      adviceBn = ms.adviceBn;
      adviceEn = ms.adviceEn;
      method = "model";
      shortfallProb = fc.pShortfall;
      modelVersion = fc.modelVersion;
    }
    const dailyBudgetPaisa = Math.trunc(safeTotalPaisa / Math.max(windowDays, 1));

    // Categories: outflow totals per Sathi category.
    const totals = new Map<string, number>();
    let outflowSum = 0;
    for (const t of txns) {
      if (t.direction === "in") continue;
      const cat = categorize(t).category;
      const amount = t.amount + (t.category === "cash_out" ? cashoutFee(t.amount) : 0);
      totals.set(cat, (totals.get(cat) ?? 0) + amount);
      outflowSum += amount;
    }
    const categories = [...totals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat, total]) => ({
        category: cat,
        label_bn: SATHI_CATEGORY_LABELS[cat as keyof typeof SATHI_CATEGORY_LABELS].bn,
        label_en: SATHI_CATEGORY_LABELS[cat as keyof typeof SATHI_CATEGORY_LABELS].en,
        total_paisa: total * 100,
        total_display: formatTaka(total, "bn"),
        share: outflowSum ? total / outflowSum : 0,
        share_display: formatProbability(outflowSum ? total / outflowSum : 0, "bn"),
      }));

    // Insights from reviewed templates — every figure preformatted here.
    const insights: { id: string; label: string; text_bn: string; text_en: string }[] = [];
    insights.push({
      id: "safe_to_spend",
      label: method === "model" ? "Prediction" : "Data",
      text_bn:
        method === "model"
          ? `পরবর্তী আয়ের আগ পর্যন্ত নিয়মিত বিল ও সম্ভাব্য খরচ হিসাব করে আপনার নিরাপদ ব্যয়ের সীমা প্রায় ${formatTaka(safeTotalPaisa / 100, "bn")} (দৈনিক ${formatTaka(dailyBudgetPaisa / 100, "bn")})।`
          : `আগামী ১৪ দিনের সব সম্ভাব্য নিয়মিত বিল ও আবশ্যক খরচ মিটিয়ে আপনার নিরাপদ ব্যয়ের সীমা প্রায় ${formatTaka(s2s.safeToSpendTotal, "bn")} (দৈনিক ${formatTaka(s2s.dailySafeBudget, "bn")})।`,
      text_en:
        method === "model"
          ? `Accounting for upcoming bills and likely spending until your next income, your safe-to-spend limit is ${formatTaka(safeTotalPaisa / 100, "en")} (~${formatTaka(dailyBudgetPaisa / 100, "en")}/day).`
          : `After covering upcoming bills and essentials, your safe-to-spend limit is ${formatTaka(s2s.safeToSpendTotal, "en")} (~${formatTaka(s2s.dailySafeBudget, "en")}/day) over the next 14 days.`,
    });

    const months = [...monthlyTotals(txns).values()];
    if (months.length) {
      const last = months[months.length - 1];
      insights.push({
        id: "income_spend",
        label: "Data",
        text_bn: render("summary_income_spend", "bn", templateVarsIncomeSpend({ income: last.inflow, spend: last.outflow }, "bn")),
        text_en: render("summary_income_spend", "en", templateVarsIncomeSpend({ income: last.inflow, spend: last.outflow }, "en")),
      });
    }
    const weeks = weeklyOutflows(txns);
    const largest = weeks.find((w) => w.isLargest);
    if (largest) {
      insights.push({
        id: "largest_week",
        label: "Data",
        text_bn: render("summary_largest_week", "bn", templateVarsLargestWeek({ weekDate: new Date(largest.start), amount: largest.outflow }, "bn")),
        text_en: render("summary_largest_week", "en", templateVarsLargestWeek({ weekDate: new Date(largest.start), amount: largest.outflow }, "en")),
      });
    }
    const feeTotal = txns
      .filter((t) => t.direction === "out" && t.category === "cash_out")
      .reduce((s, t) => s + cashoutFee(t.amount), 0);
    if (feeTotal > 0) {
      insights.push({
        id: "fees",
        label: "Data",
        text_bn: render("summary_fees", "bn", { fees: formatTaka(feeTotal, "bn") }),
        text_en: render("summary_fees", "en", { fees: formatTaka(feeTotal, "en") }),
      });
    }
    if (metrics.bufferDays !== null) {
      insights.push({
        id: "buffer",
        label: "Data",
        text_bn: render("summary_buffer", "bn", templateVarsDays({ days: metrics.bufferDays }, "bn")),
        text_en: render("summary_buffer", "en", templateVarsDays({ days: metrics.bufferDays }, "en")),
      });
    }
    if (confidence === "low") {
      insights.push({
        id: "low_data",
        label: "Data",
        text_bn: render("summary_low_data", "bn"),
        text_en: render("summary_low_data", "en"),
      });
    }

    const persona = personaOfUser(user);
    const data = {
      user: { persona: persona.id, persona_label_bn: persona.labelBn, persona_label_en: persona.labelEn },
      as_of_date: asOf,
      balance_paisa: balance * 100,
      balance_display: formatTaka(balance, "bn"),
      confidence,
      liquidity_basis,
      safe_to_spend: {
        safe_to_spend_total_paisa: safeTotalPaisa,
        safe_to_spend_total_display: formatTaka(safeTotalPaisa / 100, "bn"),
        safe_to_spend_wallet_paisa: s2s.safeToSpendWallet * 100,
        safe_to_spend_wallet_display: formatTaka(s2s.safeToSpendWallet, "bn"),
        daily_safe_budget_paisa: dailyBudgetPaisa,
        daily_safe_budget_display: formatTaka(dailyBudgetPaisa / 100, "bn"),
        upcoming_commitments_paisa: s2s.upcomingCommitments * 100,
        upcoming_commitments_display: formatTaka(s2s.upcomingCommitments, "bn"),
        safety_buffer_paisa: s2s.safetyBuffer * 100,
        safety_buffer_display: formatTaka(s2s.safetyBuffer, "bn"),
        wallet_balance_paisa: s2s.walletBalance * 100,
        wallet_balance_display: formatTaka(s2s.walletBalance, "bn"),
        status,
        status_label_bn: statusLabelBn,
        status_label_en: statusLabelEn,
        horizon_days: windowDays,
        advice_bn: adviceBn,
        advice_en: adviceEn,
        // ML handoff fields (backward-compatible additions):
        method,
        rule_safe_to_spend_paisa: s2s.safeToSpendTotal * 100,
        rule_safe_to_spend_display: formatTaka(s2s.safeToSpendTotal, "bn"),
        shortfall_prob: shortfallProb,
        model_version: modelVersion,
      },
      cash_on_hand: {
        estimated_cash_paisa: eff.cashTaka * 100,
        estimated_cash_display: formatTaka(eff.cashTaka, "bn"),
        // observed trailing 21-day cash-out total + the daily burn it implies
        trailing_cashout_total_paisa: Math.round(trailingCashoutTotal) * 100,
        trailing_cashout_total_display: formatTaka(Math.round(trailingCashoutTotal), "bn"),
        daily_cash_burn_paisa: Math.round(dailyCashBurn) * 100,
        daily_cash_burn_display: formatTaka(Math.round(dailyCashBurn), "bn"),
        days_of_cash_remaining: dailyCashBurn > 0 ? Math.round(balance / dailyCashBurn) : null,
        confidence,
        effective_cash_paisa: eff.cashTaka * 100,
        effective_cash_display: formatTaka(eff.cashTaka, "bn"),
        other_liquid_paisa: otherLiquid * 100,
        source: eff.source,
      },
      recurring: {
        inflows: recurringIn.map((r) => ({
          item_id: r.key,
          title_bn: r.label,
          title_en: r.label,
          category: r.category,
          direction: "in",
          amount_paisa: r.avgAmount * 100,
          amount_display: formatTaka(r.avgAmount, "bn"),
          periodicity: r.cadence,
          expected_day_of_month: r.typicalDayOfMonth,
          occurrence_count: r.occurrences,
        })),
        outflows: recurringOut.map((r) => ({
          item_id: r.key,
          title_bn: r.label,
          title_en: r.label,
          category: r.category,
          direction: "out",
          amount_paisa: r.avgAmount * 100,
          amount_display: formatTaka(r.avgAmount, "bn"),
          periodicity: r.cadence,
          expected_day_of_month: r.typicalDayOfMonth,
          occurrence_count: r.occurrences,
        })),
        total_monthly_inflow_paisa: recurringIn.reduce((s, r) => s + r.monthlyEstimate, 0) * 100,
        total_monthly_outflow_paisa: recurringOut.reduce((s, r) => s + r.monthlyEstimate, 0) * 100,
        detected_from: "transaction history only — never persona/config",
      },
      metrics: {
        monthly_income_paisa: metrics.monthlyIncome * 100,
        monthly_income_display: formatTaka(metrics.monthlyIncome, "bn"),
        monthly_spend_paisa: metrics.monthlySpend * 100,
        monthly_spend_display: formatTaka(metrics.monthlySpend, "bn"),
        savings_rate: metrics.savingsRate,
        savings_rate_display: metrics.savingsRate === null ? null : formatProbability(metrics.savingsRate, "bn"),
        income_volatility: metrics.incomeVolatility,
        income_volatility_display: metrics.incomeVolatility === null ? null : formatProbability(metrics.incomeVolatility, "bn"),
        buffer_days: metrics.bufferDays,
        buffer_days_display: metrics.bufferDays === null ? null : toBanglaDigits(String(Math.round(metrics.bufferDays))),
        cash_dependency_ratio: metrics.cashDependencyRatio,
        cash_dependency_ratio_display: metrics.cashDependencyRatio === null ? null : formatProbability(metrics.cashDependencyRatio, "bn"),
        fee_leakage_paisa: feeTotal * 100,
        fee_leakage_display: formatTaka(feeTotal, "bn"),
        fixed_commitment_ratio: metrics.fixedCommitmentRatio,
        fixed_commitment_ratio_display: metrics.fixedCommitmentRatio === null ? null : formatProbability(metrics.fixedCommitmentRatio, "bn"),
      },
      categories,
      insights,
    };

    const evidence = buildEvidence({
      nTransactions: txns.length,
      windowStart,
      asOfDate: asOf,
      labels: {
        balance: "Data", safe_to_spend: method === "model" ? "Prediction" : "Data",
        cash_on_hand: "Data",
        recurring_commitments: "Data", monthly_income: "Data", monthly_spend: "Data",
        categories: "Data", insights: "Data", fee_rate: "Assumption",
      },
      forecastVersion: modelVersion ?? undefined,
    });
    return ok(data, evidence);
  } catch (e) {
    console.error("[v1 summary]", e);
    return notFound("Summary failed");
  }
}

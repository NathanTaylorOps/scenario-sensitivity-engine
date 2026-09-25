# Benchmark data reference

Input ranges for the manufacturer persona are grounded in real, checkable
figures rather than round or arbitrary numbers. Australian figures, 2025-2026
vintage, in AUD. Ranges marked "reasoned estimate" are standard rules of
thumb rather than tied to one statistic, since no single authoritative source
exists — that's stated here plainly rather than presented as more precise
than it is. Where no independent Australian data point exists for a cost or
revenue line, the range is scaled from a US benchmark at roughly the current
AUD/USD exchange rate — labelled as such below, and distinct from the wage
and tax figures, which are independently sourced Australian data, not FX
conversions.

| Driver | Range used | Basis |
|---|---|---|
| 2nd CNC/line capex | A$210K–A$700K (mid-size new CNC) | Australian equipment dealer listings (Machines4U, Machinio); scaled up from the US price for the same machine class for freight and duty on imported machine tools |
| CNC line maintenance/service (machine-only, no labor) | A$11K–A$39K/yr, ~5-8% of capex | CNC service-contract rule of thumb, scaled from a US benchmark at roughly current FX |
| Gross/contribution margin | 25–40% (job-shop custom work up to 45%) | Industry benchmark ranges (percentage, not currency-scaled) |
| CNC operator wage (second-shift headcount only) | A$65K–A$105K/yr (median ~A$80K/yr) | [Seek](https://au.seek.com/career-advice/role/computer-numerical-control-operator/salary), [Indeed](https://au.indeed.com/career/cnc-operator/salaries) — independently sourced Australian wage data, not an FX conversion |
| Target payback | 2–4 years typical for discretionary capex | Small-business capital budgeting norm |
| Discount rate / hurdle rate | 10–15% typical (8% conservative floor, 15–18% for riskier capex) | Australian small-business finance practice — a few points above the RBA cash rate plus a small-business risk premium |
| Fixed/variable cost split | ~60–70% variable / 30–40% fixed for a discrete-parts shop | Reasoned estimate |
| Company tax rate | 25% base-rate entity / 30% otherwise | [ATO](https://www.ato.gov.au/tax-rates-and-codes/company-tax-rate-changes) — base-rate entity requires aggregated turnover under A$50m and no more than 80% passive income |

## Persona B: heavy-machinery repair & mine-site logistics workshop

| Driver | Range used | Basis |
|---|---|---|
| Field-service truck capex (crane/welder/generator, fitted) | A$252K–A$630K | Heavy-equipment dealer/auction listings, scaled up from the US price for freight, duty, and a thinner Australian secondary market for fitted-out service trucks |
| Truck/crane/tooling maintenance (machine-only, no labor) | A$21K–A$63K/yr, ~6-9% of capex | Fleet-maintenance rule of thumb, scaled from a US benchmark at roughly current FX |
| Remote-response crew wage (FIFO heavy diesel / mobile plant mechanic) | A$130K–A$200K+/yr | [RosterElf](https://www.rosterelf.com/blog/mining-fifo-worker-pay-australia) FIFO trades pay survey — independently sourced Australian wage data, not an FX conversion; actual total package depends on roster, site enterprise agreement, and penalty/loading rates |
| Logistics/haulage contract gross margin | 8–45% (typical range 30-45%) | Trucking/logistics industry margin benchmarks (percentage, not currency-scaled) |

Two figures are stated design choices rather than external data points: the
0.25 macro-demand sensitivity (vs. the manufacturer persona's 0.15) reflects
mine-site service demand being more directly commodity-cycle-exposed, and
the lower incremental-call-out volume paired with a higher per-call-out
margin reflects a travel-time-constrained remote service model rather than
an on-site production line — both are stated as reasoning, not sourced
statistics, in the persona's own driver rationale strings.

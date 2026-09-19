---
schema_version: 1
decision_id: 2026-06-19-000000-01
decided_at: 2026-09-19T11:20:00+09:00
provenance: retro_seed
supersedes: null

retro_seed:
  as_of: 2026-06-19
  bounded_sources:
    - "kis chart technical --stock-code 000000 --end-date 20260619 --count 120"
  excluded_skills:
    - fundamental-analysis
  leakage_risk: high
  cohort: fixture-cohort

data_as_of:
  price: 2026-06-19

market: KOSPI
symbol: "000000"
name: 픽스처

verdict: buy
confidence: medium
horizon_days: 90
review_due: 2026-09-17

reference:
  price: 81300
  currency: KRW
  price_type: close
  adjusted: true

levels:
  entry: { min: 80000, max: 82500 }
  stop_loss: 73535
  targets:
    - { price: 91654, weight: 1.0 }
  risk_reward: 1.6

thesis: 픽스처용 판단이다.
biggest_risk: "픽스처용 리스크 문장이다."

invalidation:
  - id: inv-1
    statement: 주간 종가가 SMA60 아래로 이탈
    checkable: true
    metric: price
    op: "<"
    value: 72023
    source: kis chart technical
    check_on: weekly
  - id: inv-2
    statement: 종가가 손절선 하회
    checkable: true
    metric: price
    op: "<"
    value: 73535
    source: kis stock current-price
    check_on: daily

gates:
  data_sanity: warn

skills_run:
  - technical-analysis

scoring:
  status: pending
---

본문.

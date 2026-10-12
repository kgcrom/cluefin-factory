# final-decision 출력 스키마 — 설계 노트와 예시

스키마 정의: [`final-decision.schema.json`](./final-decision.schema.json)

판단은 **YAML frontmatter(기계 판독용) + 본문(사람용)** 으로 내고, `market-review` 리포트의
부록에 그대로 붙는다.

## 설계 원칙

1. **기한 없는 판단은 검증할 수 없다.** 그래서 `horizon_days`가 필수다.
2. **기준일을 전부 남긴다.** `data_as_of`는 사후에 "그때 알 수 있었던 정보였나"를 확인하는
   유일한 수단이다. 재무 회계기준일과 공시일을 분리한 것도 같은 이유다.
3. **무효화 조건은 술어(predicate)로 쓴다.** 자연어만 있으면 사람이 매번 해석해야 한다.
   못 쓰는 조건은 `checkable: false`로 솔직히 표시한다.
4. **`skills_run`을 남긴다.** 어떤 분석을 붙여 낸 판단인지 나중에 구분하기 위해서다.

## 예시

```markdown
---
schema_version: 1
decision_id: 2026-09-16-005930-01
decided_at: 2026-09-16T16:10:00+09:00

data_as_of:
  price: 2026-09-16
  financial: 2026-06-30
  financial_disclosed_at: 2026-08-14
  news_scanned_through: 2026-09-16
  macro: 2026-09-12

market: KOSPI
symbol: "005930"
name: 삼성전자

verdict: buy
confidence: medium
horizon_days: 90
review_due: 2026-12-15

reference:
  price: 71800
  currency: KRW
  price_type: close
  adjusted: true

levels:
  entry: { min: 69000, max: 72500 }
  stop_loss: 64500
  targets:
    - { price: 82000, weight: 0.6 }
    - { price: 90000, weight: 0.4 }
  risk_reward: 2.1

thesis: HBM 물량이 2027년까지 선계약으로 묶이면서 메모리 사이클 하강 구간의 실적 변동성이 과거보다 낮아진다.
key_drivers:
  - HBM3E 공급계약 물량 확대
  - 파운드리 적자폭 축소 추세
  - 외국인 20일 순매수 전환
biggest_risk: 범용 D램 가격이 먼저 꺾이면 HBM 마진이 전사 실적을 방어하지 못한다.

debate:
  bull_score: 7
  bear_score: 5
  winner: bull
  decisive_factor: 파운드리 적자 축소가 bear의 핵심 논거를 약화시킴

invalidation:
  - id: inv-1
    statement: 종가가 손절선 64500원을 종가 기준 이탈
    checkable: true
    metric: price
    op: "<"
    value: 64500
    source: kis stock current-price
    check_on: daily
  - id: inv-2
    statement: 분기 보고서에서 영업이익이 전년 동기 대비 역성장
    checkable: true
    metric: operating_profit_growth_yoy
    op: "<"
    value: 0
    source: dart financial-major-indicators
    check_on: quarterly
  - id: inv-3
    statement: 주요 고객사가 HBM 공급처를 이원화한다는 공시 또는 확인된 보도
    checkable: false

tracking:
  - { metric: foreign_net_buy_20d, source: kis stock current-price, expected: up }
  - { metric: rsi_14, source: kis chart technical, expected: flat }

gates:
  data_sanity: warn
  notes:
    - 국내 금리와 미국 금리 기준일이 3일 어긋남 — 매크로 해석은 참고용
    - 환율 명령 부재로 FX 배경 미반영

skills_run:
  - data-sanity-check
  - fundamental-analysis
  - technical-analysis
  - bull-analyst
  - bear-analyst
  - final-decision
skills_skipped:
  - macro-analysis
  - news-analysis
  - scenario-planner
---

# 삼성전자 (005930) — buy

## 핵심 근거
(본문은 사람이 읽는 리포트. frontmatter의 필드를 산문으로 풀어 쓴다.)

## bull case
...

## bear case
...
```

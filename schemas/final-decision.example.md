# final-decision 출력 스키마 — 설계 노트와 예시

스키마 정의: [`final-decision.schema.json`](./final-decision.schema.json)

저장 위치는 기존 `investment-journal` 규칙을 그대로 쓴다 —
`.claude/investments/journal/YYYY-MM-DD-SYMBOL.md`.
**YAML frontmatter는 기계용(채점 봇이 이것만 읽는다), 본문은 사람용**이다.
투자 정보는 민감 정보이므로 이 디렉터리는 계속 git-ignore한다.

## 설계 원칙

1. **채점 가능하지 않으면 필드가 아니다.** `horizon_days`가 필수인 이유 — 기한 없는 판단은
   영원히 "아직 모른다"로 남아 채점이 안 된다.
2. **기준일을 전부 남긴다.** `data_as_of`는 사후에 "그때 알 수 있었던 정보였나"를 검증하는
   유일한 수단이다. 재무 회계기준일과 공시일을 분리한 것도 같은 이유다.
3. **무효화 조건은 술어(predicate)로 쓴다.** 자연어만 있으면 사람이 매번 해석해야 한다.
   못 쓰는 조건은 `checkable: false`로 솔직히 표시한다 — 그 비율 자체가 품질 지표다.
4. **초과수익으로 채점한다.** 지수가 20% 오른 구간의 +15%는 실패다. `benchmark_return_pct`.
5. **`scoring` 블록에 `status: pending` 외의 값을 final-decision이 쓰지 않는다.**
   자기 판단을 자기가 채점하면 스코어보드가 무의미해진다.
6. **`skills_run`을 남긴다.** "macro-analysis를 붙였을 때 성적이 더 좋은가"를
   나중에 데이터로 답하기 위해서다.

## 예시 (발행 직후)

```markdown
---
schema_version: 1
decision_id: 2026-09-16-005930-01
decided_at: 2026-09-16T16:10:00+09:00
supersedes: null

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
    statement: 분기 영업이익률이 8% 아래로 하락
    checkable: true
    metric: operating_margin
    op: "<"
    value: 0.08
    source: kis financial profitability
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
  - portfolio-fit
  - bull-analyst
  - bear-analyst
  - final-decision
skills_skipped:
  - macro-analysis
  - news-analysis
  - scenario-planner

scoring:
  status: pending
---

# 삼성전자 (005930) — buy

## 핵심 근거
(본문은 사람이 읽는 리포트. frontmatter의 필드를 산문으로 풀어 쓴다.)

## bull case
...

## bear case
...

## 사후 복기 항목
...
```

## 예시 (채점 후 — 채점 봇이 `scoring`만 덮어쓴다)

```yaml
scoring:
  status: scored
  scored_at: 2026-12-15T09:10:00+09:00
  price_at_review: 78400
  return_pct: 9.19
  benchmark_return_pct: 11.40
  max_drawdown_pct: -7.2
  stop_hit: false
  target_hit: false
  invalidated_by: []
  outcome: incorrect   # 절대수익은 +지만 벤치마크 하회 → 판단으로서는 실패
  notes: 방향은 맞았으나 초과수익 실패. bull_score 7이 과했는지 검토.
```

`status` 값의 뜻:

| 값 | 의미 |
| --- | --- |
| `pending` | 발행됨, 아직 기한 미도래 |
| `scored` | `review_due` 도래 후 정상 채점 |
| `invalidated` | 기한 전에 `invalidation` 조건 발동 → 그 시점 가격으로 조기 채점 |
| `superseded` | 기한 전에 같은 종목 새 판단이 나옴 (새 판단의 `supersedes`가 이 id를 가리킴) |
| `void` | 상장폐지·거래정지·데이터 오류로 채점 불가 |

## 집계 지표 (스코어보드가 계산할 것)

- verdict별 적중률과 평균 초과수익 (buy/sell/hold/watch)
- `confidence`와 실제 적중률의 상관 — 캘리브레이션이 맞는가
- `debate.winner`가 bear일 때 vs bull일 때의 성과 차이
- `invalidation` 발동률과, 발동 후 손실 회피 폭
- `checkable: false` 조건의 비율 (낮을수록 좋다)
- `gates.data_sanity`가 `warn`인 판단의 성과 저하 폭
- `skills_run`에 macro/news 포함 여부에 따른 성과 차이

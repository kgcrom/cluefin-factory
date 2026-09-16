---
name: decision-scorecard
description: journal에 쌓인 과거 투자 판단을 기한 도래·무효화 조건 발동 기준으로 채점하고, 적중률·초과수익·확신도 캘리브레이션을 집계한다. 판단 성적표, 복기, 사후 검증 요청에 사용한다.
model: sonnet
---

# Decision Scorecard

`.claude/investments/journal/`에 쌓인 과거 판단을 **오늘 값과 대조해 채점**한다.
과거 구간에 분석을 다시 돌리는 백테스트가 아니다. 이미 발행된 판단을 미래가 채점하는
forward test이며, 판단 시점에는 결과를 알 수 없었다는 점이 이 방식의 유일한 근거다.

**새로 분석하지 않는다.** 여기서 하는 일은 저장된 숫자와 조회한 숫자를 비교하는 산술이다.
채점 중에 종목 전망을 새로 내거나 판단을 수정하지 않는다.

## 입력

- `.claude/investments/journal/*.md`의 YAML frontmatter
  (스키마: `schemas/final-decision.schema.json`)
- cluefin CLI로 조회한 현재값

frontmatter가 스키마를 따르지 않는 파일은 건너뛰고, 건너뛴 파일 목록을 보고한다.
형식을 추측해서 복원하지 않는다.

## 절차

### 1. 대상 선별

`scoring.status`가 `pending`인 판단만 본다. 그중,

- `review_due <= 오늘` → 정기 채점 대상
- 그 외 → 무효화 조건만 확인 (조기 채점 여부 판단)

같은 종목에 더 최근 판단이 있고 그 판단의 `supersedes`가 이 판단을 가리키면,
`status: superseded`로 닫고 수익률은 계산하지 않는다.

### 2. 현재값 조회

무효화 조건의 `source` 필드가 호출할 명령을 지정한다. 종목당 필요한 것만 부른다.

```bash
# 현재가 (거의 항상 필요)
uv run cluefin-openapi-cli kis stock current-price --symbol 005930

# check_on: quarterly 조건이 있을 때만
uv run cluefin-openapi-cli kis financial profitability --symbol 005930

# 구간 최고/최저가가 필요할 때 (target_hit, max_drawdown 계산)
uv run cluefin-openapi-cli kis chart period --symbol 005930 --start ... --end ...
```

명령 경로가 확실하지 않으면 `search <자연어> --json` → `schema <경로> --json`으로 확인한다.
exit code 4는 `error.retryable`일 때만 재시도하고, 5(rate limit)면 남은 종목을 중단한 뒤
어디까지 채점했는지 보고한다.

### 3. 무효화 조건 확인

`checkable: true`인 항목만 기계적으로 비교한다.
`metric`/`op`/`value`를 그대로 적용하고, 해석을 덧붙이지 않는다.

하나라도 발동하면 그 시점 가격으로 조기 채점한다.
`status: invalidated`, `invalidated_by`에 발동한 id를 모두 적는다.

`checkable: false` 항목은 자동 판정하지 않는다. 사용자에게 "확인이 필요한 조건"으로
따로 보여주고, 사용자가 발동했다고 답한 경우에만 반영한다.

### 4. 성과 계산

- `return_pct` = (현재가 − `reference.price`) / `reference.price` × 100
  `verdict`가 `sell`이면 부호를 뒤집는다 (하락을 맞힌 것이므로).
  `watch`는 수익률을 계산하되 `outcome` 판정에서는 참고값으로만 쓴다.
- `benchmark_return_pct`: 같은 기간 지수 수익률.
  KOSPI는 `069500`(KODEX 200), KOSDAQ은 `229200`(KODEX 코스닥150)을 대용으로 쓴다.
- `outcome` 판정은 **초과수익 기준**이다.
  - `return_pct − benchmark_return_pct > 0` → `correct`
  - `< 0` → `incorrect` (절대수익이 플러스여도 마찬가지다)
  - 지수 데이터를 못 구했거나 `reference.adjusted: false`인데 그 사이 액면분할·유상증자가
    있었으면 → `inconclusive`. 억지로 보정하지 않는다.
  - 상장폐지·거래정지로 조회 불가 → `status: void`

`reference.adjusted`가 false인 판단은 결과에 **수정주가 미반영 경고**를 함께 표시한다.

### 5. 기록

각 journal 파일의 **`scoring` 블록만** 덮어쓴다.
frontmatter의 다른 필드와 본문은 건드리지 않는다. 과거 판단을 사후에 고치면 성적표가
무의미해진다.

## Retro seed 프로토콜 (표본 부트스트랩)

forward 표본이 쌓이기를 기다리는 동안, **과거 기준일 데이터로 판단을 만들고 오늘 값으로
채점해** 표본을 앞당길 수 있다. 성립하는 이유는 하나뿐이다 — 모델의 학습 컷오프 이후
구간이면 그 기간의 주가 흐름을 모델이 모른다.

이 방식으로 만든 판단은 `provenance: retro_seed`로 표시하고, `retro_seed` 블록에
누수 통제 내역을 남긴다. **forward 표본과 합산하지 않는다.**
retro seed가 검증하는 것은 "판단 로직이 작동하는가"이지 "이 에이전트를 믿어도 되는가"가
아니다. 후자는 forward 표본만 답할 수 있다.

### 1. as_of와 horizon 잡기

`as_of + horizon_days <= 오늘`이어야 하므로, horizon을 늘리면 as_of가 과거로 밀린다.
as_of가 모델 학습 컷오프에 가까울수록 누수 위험이 커진다.

| horizon | as_of | leakage_risk |
| --- | --- | --- |
| 30일 | 오늘 − 30일 | low |
| 60일 | 오늘 − 60일 | low |
| 90일 | 오늘 − 90일 | medium |
| 120일 이상 | 오늘 − 120일 | **high — 컷오프와 겹치는지 먼저 확인** |

as_of가 학습 컷오프보다 앞서거나 30일 이내로 가까우면 `leakage_risk: high`로 적고,
집계에서 별도 표로 뺀다. 컷오프는 무른 경계이므로 "겹치지 않으니 안전하다"고 단정하지
않는다.

### 2. 조회를 as_of로 고정

as-of 지정이 되는 명령만 쓴다. 확인된 현황:

| 명령 | as-of | 비고 |
| --- | --- | --- |
| `kis chart technical` | `--end-date YYYYMMDD` | "Analyze as of this date". 지표·시그널 재현 가능 |
| `kis chart period` | `--start-date` / `--end-date` | `--adj-price 0`(수정주가) 함께 지정 |
| `kis financial *` | **없음** | 최신 정정본만 반환 — 쓰면 look-ahead |
| 웹 검색 기반 뉴스 | 없음 | 오늘 기사가 딸려온다 |

따라서 retro seed 판단은 **기술적 분석 기반으로만** 만든다.
`fundamental-analysis`, `news-analysis`, `macro-analysis`는 `excluded_skills`에 적고
실제로 호출하지 않는다. 재무 수치를 기억으로 채워 넣지 않는다 — 그 순간 실험이 무효다.

호출한 명령은 `--end-date`까지 포함해 전문을 `bounded_sources`에 그대로 남긴다.
나중에 누수를 의심할 때 이 기록만이 검증 수단이다.

### 3. 판단 생성

`as_of` 시점 데이터만 놓고 `final-decision` 스키마대로 판단을 낸다.

- `decided_at`은 **실제 생성 시각(오늘)** 을 적는다. as_of로 위조하지 않는다.
- `decision_id`의 날짜 부분은 `as_of`를 쓴다 (정렬·조회 편의).
- `review_due` = `as_of` + `horizon_days`.
- `scoring.status`는 `pending`으로 둔다. 생성과 채점을 한 단계에서 하지 않는다 —
  판단을 내리면서 결과를 보면 그 자체가 누수다.

같은 종목을 여러 horizon으로 돌릴 때는 각각 별도 판단으로 만들고, 같은 `cohort` 값을
부여한다.

### 4. 채점

이후는 일반 채점과 동일하다. `review_due`가 이미 지났으므로 생성 직후 채점 대상이 된다.
채점은 **판단 생성과 분리된 실행**에서 한다.

### 5. 집계 시 주의

- retro seed와 forward를 같은 표에 넣지 않는다.
- **같은 `cohort`는 독립 표본이 아니다.** 한 종목을 30/60/90일로 돌린 3건은 시작점만
  다를 뿐 겹치는 구간을 보는 것이라 상관관계가 크다. 적중률을 셀 때는 cohort 단위로
  묶어 세거나, horizon별로 표를 나눈다. 3건을 표본 3개로 세지 않는다.
- horizon별 성과 차이는 보고할 가치가 있다 — 이 판단 로직이 단기에 강한지 중기에
  강한지가 드러난다.
- 생존 편향은 retro seed에서 구조적으로 남는다. 오늘 시점에서 종목을 고르는 이상
  상장폐지·거래정지 종목이 애초에 후보에 없다. `universe_note`에 어떻게 골랐는지 적고,
  결과에 이 한계를 함께 표시한다.

## 집계

채점이 끝나면 전체 이력으로 다음을 낸다. 표본이 10건 미만인 구간은 건수를 함께 표시하고
결론을 내리지 않는다.

| 지표 | 계산 |
| --- | --- |
| verdict별 적중률 | buy/sell/hold/watch 각각의 `outcome: correct` 비율 |
| verdict별 평균 초과수익 | `return_pct − benchmark_return_pct`의 평균 |
| 확신도 캘리브레이션 | `confidence` high/medium/low별 적중률. high가 더 낮으면 경고 |
| bull/bear 신뢰도 | `debate.winner`별 실제 성과. bear가 이겼는데 buy를 낸 건의 결과 |
| 무효화 조건 효용 | `invalidated` 비율과, 조기 종료 시점 대비 기한까지 갔을 때의 손실 차이 |
| 조건 품질 | 전체 `invalidation` 중 `checkable: false` 비율 (낮을수록 좋다) |
| 데이터 품질 영향 | `gates.data_sanity`가 `warn`인 판단의 초과수익 저하 폭 |
| 스킬 기여도 | `skills_run`에 macro-analysis / news-analysis 포함 여부별 성과 차이 |

## 보고

성적표는 듣기 좋게 쓰지 않는다. 적중률이 낮으면 낮다고 쓰고, 표본이 부족하면
"아직 판단할 수 없다"고 쓴다. 우연한 수익을 실력으로 해석하지 않는다.

개선 제안은 집계에서 실제로 드러난 패턴에 한해 낸다.
예를 들어 확신도 캘리브레이션이 역전돼 있으면 그 사실만 지적하고, 원인 추정은
사용자에게 맡긴다.

## 주의

- 개인 투자 기록은 민감 정보다. journal 내용을 외부로 전송하지 않는다.
- 이 스킬은 매수/매도를 권하지 않는다. 과거 판단의 채점만 한다.
- `transactions.csv`의 실제 체결 기록과 journal의 판단은 별개다.
  실제 수익률을 묻는 경우 두 파일이 다를 수 있음을 먼저 밝힌다.

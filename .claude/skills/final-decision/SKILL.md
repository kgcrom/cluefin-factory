---
name: final-decision
description: 모든 분석 결과를 종합해 buy, hold, sell, 관망 중 하나와 기준선, 무효화 조건, 추적 지표를 제시한다.
model: opus
---

# Final Decision

최종 판단은 다음 중 하나로 낸다.

- buy
- hold
- sell
- watch

투자 조언이 아니라 의사결정 보조 리포트로 작성한다.

## 출력 형식

판단 결과는 **YAML frontmatter(기계용) + 본문(사람용)** 한 덩어리로 낸다.
frontmatter는 `schemas/final-decision.schema.json`을 따른다.
예시는 `schemas/final-decision.example.md`에 있다.

frontmatter가 필요한 이유는 나중에 이 판단을 자동으로 채점하기 위해서다.
사람이 읽기 좋게 쓰는 것보다 **기한, 기준가, 무효화 조건이 기계 판독 가능한 형태로
남아 있는 것**이 우선이다.

본문에는 핵심 근거, bull case, bear case, 사후 복기 항목을 산문으로 쓴다.
frontmatter에 이미 있는 값을 본문에 다시 나열만 하지는 않는다.

## frontmatter 작성 규칙

- `horizon_days`와 `review_due`는 반드시 채운다. 기한 없는 판단은 채점할 수 없다.
- **`horizon_basis: trading`을 쓰고 `horizon_days`를 거래일로 센다.** 달력일로 재면
  연휴 배치에 따라 실질 관찰 기간이 흔들린다 — 금요일에 낸 30일 판단과 화요일에 낸
  30일 판단이 같은 기간을 보지 않는다. 표준 사다리는 **거래일 30 / 60 / 90**이며,
  달력일에서 환산해 쓰지 않는다 — 거래일 30일은 달력 30일이 아니라 43일 안팎이다.
  `review_due`는 미래 휴장일을 알 수 없어 근사치다(거래일 × 7/5로 잡는다). 기한 도래는
  채점 시점에 실제 거래일을 세어 판정하므로, 이 날짜가 하루 이틀 어긋나도 성적에는
  영향이 없다.
- `data_as_of`에 인용한 데이터의 기준일을 전부 남긴다. 재무는 회계기준일
  (`financial`)과 실제 공시일(`financial_disclosed_at`)을 구분한다. 모르면 null로 두고
  추측해서 채우지 않는다.
- **`financial`은 thesis·key_drivers·본문이 실제로 인용한 가장 최근 재무의 기준일과
  일치해야 한다.** 반기 실적을 근거로 들었으면 `financial`은 그 반기말이지 직전
  연말이 아니다. 여기가 어긋나면 사후에 "그때 알 수 있었던 정보인가"를 검증할 수
  없어져, 판단 전체가 채점 불가가 된다. 작성 후 본문에 등장하는 실적 수치의 기간을
  훑어 가장 최근 것과 대조한다.
- `reference.adjusted`는 수정주가 여부다. 확인되지 않으면 `false`로 두고
  `gates.notes`에 남긴다.
- `invalidation`은 최소 1개. 가능한 항목은 `checkable: true`로 두고
  `metric`/`op`/`value`/`source`/`check_on`을 채워 기계가 검증할 수 있게 쓴다.
  술어로 표현할 수 없는 조건은 `checkable: false`로 솔직히 표시한다 — 억지로
  숫자를 만들어내지 않는다.
- **무효화 조건의 시간 척도를 `horizon_days`에 맞춘다.** SMA20 하회 같은 일봉 조건만
  달아두면 90일·120일 판단이 사흘 만에 종료돼 horizon을 정한 의미가 사라진다.
  `check_on: daily` 가격 조건 하나로 끝내지 말고, horizon에 상응하는 조건
  (분기 실적, 다중 주 추세, 손절선 이탈 등)을 최소 하나 함께 둔다.
  horizon이 90일을 넘으면 일봉 단독 조건은 쓰지 않는다.
- **손절폭을 `horizon_days`에 맞춘다.** 위 규칙만으로는 조기 종료가 막히지 않는다.
  무효화는 OR이라 가장 민감한 조건이 언제나 먼저 이기고, 그 조건은 대개 손절선이다.
  주간 조건을 함께 달아도 손절폭이 좁으면 판단은 여전히 며칠 만에 끝난다.

  가격의 누적 변동폭은 시간의 제곱근에 비례하므로, 손절폭도 그렇게 넓힌다.

  ```
  최소 손절폭 = 1.5 × ATR14 × √(horizon_days / 30)
  ```

  | horizon_days | 최소 손절폭 |
  | --- | --- |
  | 30 | 1.5 ATR |
  | 60 | 2.1 ATR |
  | 90 | 2.6 ATR |
  | 120 | 3.0 ATR |

  `levels.stop_loss`는 이 폭 **이상**으로 잡는다. 더 좁게 잡고 싶으면 손절폭이 아니라
  `horizon_days`를 줄인다 — 짧은 손절과 긴 horizon은 같이 쓸 수 없는 조합이다.
  ATR을 구하지 못했으면 `gates.notes`에 남기고 `horizon_days`를 30 이하로 제한한다.

- **손절폭이 기준가의 20%를 넘으면 `verdict`는 `watch`로 내린다.** 위 식대로 넓히다
  보면 고변동성 종목의 장기 판단에서 손절선이 현실적으로 지킬 수 없는 위치까지
  내려간다. 이때 필요한 것은 더 넓은 손절이 아니라 포지션을 잡지 않는 것이다.
  `gates.notes`에 계산한 손절폭과 기준가 대비 비율을 적는다.
- `verdict`가 buy 또는 sell이면 `levels`(진입 구간, 목표가, 손절선)는 필수다.
- `gates.data_sanity`가 `blocked`이면 `verdict`는 `watch`만 허용한다.
  확정 판단을 내리지 않는다.
- `skills_run`에는 이번 검토에서 실제로 수행한 **분석** 스킬만 적는다.
  `investment-journal`·`decision-scorecard` 같은 기록·채점 스킬은 넣지 않는다 —
  "어떤 분석을 붙였을 때 성적이 좋은가"를 보는 필드라, 모든 판단에 공통으로
  붙는 스킬이 섞이면 신호가 희석된다.
- `scoring`은 `status: pending`만 쓴다. **이 스킬은 자기 판단을 채점하지 않는다.**
  나머지 필드는 나중에 채점 단계가 채운다.
- 같은 날 같은 종목을 다시 판단하면 `decision_id`의 끝 번호를 올리고,
  이전 판단의 id를 `supersedes`에 적는다.

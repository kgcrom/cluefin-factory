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
- `data_as_of`에 인용한 데이터의 기준일을 전부 남긴다. 재무는 회계기준일
  (`financial`)과 실제 공시일(`financial_disclosed_at`)을 구분한다. 모르면 null로 두고
  추측해서 채우지 않는다.
- `reference.adjusted`는 수정주가 여부다. 확인되지 않으면 `false`로 두고
  `gates.notes`에 남긴다.
- `invalidation`은 최소 1개. 가능한 항목은 `checkable: true`로 두고
  `metric`/`op`/`value`/`source`/`check_on`을 채워 기계가 검증할 수 있게 쓴다.
  술어로 표현할 수 없는 조건은 `checkable: false`로 솔직히 표시한다 — 억지로
  숫자를 만들어내지 않는다.
- `verdict`가 buy 또는 sell이면 `levels`(진입 구간, 손절선, 목표가)는 필수다.
- `gates.data_sanity`가 `blocked`이면 `verdict`는 `watch`만 허용한다.
  확정 판단을 내리지 않는다.
- `skills_run`에는 이번 검토에서 실제로 수행한 스킬만 적는다.
- `scoring`은 `status: pending`만 쓴다. **이 스킬은 자기 판단을 채점하지 않는다.**
  나머지 필드는 나중에 채점 단계가 채운다.
- 같은 날 같은 종목을 다시 판단하면 `decision_id`의 끝 번호를 올리고,
  이전 판단의 id를 `supersedes`에 적는다.

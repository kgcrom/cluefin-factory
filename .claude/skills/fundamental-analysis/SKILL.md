---
name: fundamental-analysis
description: 기업의 재무제표, 밸류에이션, 성장성, 수익성, 현금흐름, 부채 구조를 분석한다. 기본적 분석이 필요할 때 사용한다.
model: opus
effort: high
---

# Fundamental Analysis

다음 항목을 분석한다.

- 매출 성장률
- 영업이익률
- 순이익률
- ROE, ROA
- 부채비율
- 영업현금흐름
- PER, PBR, PSR
- 업종 평균 대비 위치

데이터 기준:
- **최신 실적과 비율·성장률은 DART**, 과거 5개년 추세와 주당지표(EPS·BPS)는 KIS다.
  조회 명령과 그 이유는 `.claude/agents/market-review.md`의 재무 항목에 있다.
- 출처를 `dart-<보고서코드>`(11011 사업 / 11012 반기 / 11013 1Q / 11014 3Q) 또는
  `kis-annual`로 출력에 명시하고, 사용한 기간 목록을 함께 적는다.
- 두 출처를 함께 썼다면 어느 수치가 어느 출처인지 표에 적는다. 섞인 채로 성장률을
  계산하면 기준이 다른 값을 빼게 된다.
- KIS에서 가져온 값(주당지표, DART가 비운 비율)은 최신 실적보다 뒤처진 기간일 수 있으므로
  그 기준 기간을 함께 쓴다.
- 사업 구조와 부채 구조의 원문 근거는 `collect`의 `filing`이다. 부문별 매출·수주는
  `salesAndOrders`, 차입금·사채의 만기·이자율과 특수관계자 거래는 `notes.selected`의 표로 본다.
  표 금액은 표의 `unit` 단위 원문이라 억원으로 바꿔 쓸 때 단위를 적는다. `filing.error`나
  `truncated`면 그 근거는 "확인 필요 데이터"로 돌린다.

미국 비교 기업:
- 사업의 개요·뉴스에 미국 상장 고객사·경쟁사(예: 메모리 고객, 장비 경쟁사)가 보이면 티커와 함께
  꼽는다. 누가 비교 기업인지는 이 스킬의 판단이다 — 없으면 "해당 없음".
- `scripts/peer.mjs pick` 결과를 읽는 법: `periodic.items`에서 `uncertain: true`이거나 `warnings`가 있는
  Item은 경계가 틀렸을 수 있어 근거로 쓰지 않는다. `omitted`·`missing` Item은 본문이 없다.
  `incorporatedByReference`면 다른 문서를 가리키는 문장뿐이다.
- Item 본문(`sec filing-items --items <키>`)이 `truncated`면 `--offset-chars <next_offset>`으로 이어 읽는다.
  1A는 10만 자를 넘기도 하니 `--max-chars`로 나눠 읽고, 읽은 범위를 적는다. 금액은 원문 문자열이고 단위는
  표기 그대로다.
- 미국 회사 숫자는 그 회사의 회계연도(`fiscalYearEnd`)·통화 기준이다. 이 종목의 분기와 기간을 맞춰 쓰지 않는다.

출력은 다음 순서로 정리한다.
- 재무 데이터 기준
- 사용 기간
- 긍정 요인
- 부정 요인
- 확인 필요 데이터

추정하지 말고 데이터가 없으면 없다고 표시한다.
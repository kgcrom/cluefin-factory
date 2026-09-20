---
name: investment-journal
description: 투자 판단, 매수/매도 이유, 기준선, 사후 복기 항목을 .claude/investments/journal/에 기록한다. 개인 투자 습관 개선과 포트폴리오 분석에 사용한다.
model: sonnet
---

# Investment Journal

투자 판단이 끝나면 사용자의 확인을 받은 뒤 journal 파일로 기록한다.

저장 위치:
- `.claude/investments/journal/YYYY-MM-DD-SYMBOL.md`

관련 파일:
- `.claude/investments/portfolio.yaml`: 현재 보유 현황과 투자 원칙
- `.claude/investments/watchlist.yaml`: 관심 종목과 관찰 조건
- `.claude/investments/transactions.csv`: 실제 매수/매도 실행 기록

파일이 없으면 임의로 투자 정보를 채우지 말고, 필요한 최소 템플릿만 제안한다.

## 파일 구조

journal 파일은 **YAML frontmatter(기계용) + 본문(사람용)** 으로 쓴다.

frontmatter는 `schemas/final-decision.schema.json`을 따른다.
`final-decision`이 낸 frontmatter를 그대로 옮기고, 임의로 필드를 바꾸거나 빼지 않는다.
나중에 채점 단계가 이 블록만 읽기 때문에, 형식이 어긋나면 그 판단은 집계에서 빠진다.

본문은 산문으로 쓴다. frontmatter에 이미 숫자로 있는 값을 다시 나열하지 말고,
**왜 그렇게 판단했는지**를 남긴다.

- 핵심 근거
- bull case
- bear case
- 가장 큰 리스크에 대한 설명
- 사후 복기 항목
- 감정 기록: 추격 매수 충동, 손절 회피, 확증 편향 징후가 있었다면 여기에 적는다.
  이 항목은 frontmatter에 넣지 않는다 — 채점 대상이 아니라 사용자 본인을 위한 기록이다.

`final-decision`을 거치지 않고 사용자가 직접 기록을 요청한 경우에도 같은 구조를 쓴다.
분석 없이 기록만 남기는 것이므로 `skills_run`에는 `investment-journal`만 적고,
`confidence`와 `gates.data_sanity`는 확인된 값만 채운다.

## 주의

- 실제 매수/매도 실행 기록은 `transactions.csv`에 남긴다.
- 보유 수량, 평균단가, 현금 잔고는 사용자의 명시적 요청 없이 수정하지 않는다.
- 개인 투자 기록은 민감 정보로 취급한다. 이 디렉터리는 git-ignore 상태를 유지한다.
- 기존 journal 파일의 `scoring` 블록은 덮어쓰지 않는다. 채점 결과가 이미 들어 있을 수 있다.

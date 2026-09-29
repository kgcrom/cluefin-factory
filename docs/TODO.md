# TODO

최신화: 2026-09-29

## 워크플로우를 코드로 고정할지 검토

현재 투자 리서치 흐름은 `.claude/agents/market-review.md`가 전체 진행 순서를 지시하고,
`.claude/skills/*`가 각 분석 역할을 담당하는 구조다. 데이터는 에이전트가 외부 cluefin
CLI(`uv run cluefin-openapi-cli`)를 bash로 직접 호출해 가져온다.

역할 분리는 다음과 같다.

- `market-review` 서브에이전트: 시장/종목 입력부터 데이터 수집, sanity check, 기본적·기술적
  분석, 포트폴리오 적합성, bull/bear 의견, 최종 판단까지의 순서를 지시한다.
- cluefin CLI: KIS, Kiwoom, DART에서 가격, 재무, 공시, 지표 데이터를 가져온다.
  명령 탐색은 `search`, 파라미터 확인은 `schema`, 검증은 `--dry-run`.
- analysis skills: 수집된 데이터를 각 관점으로 해석한다.

### 지금 당장 코드로 옮기지 않는 이유

초기 단계에서는 에이전트 지시문과 skill 문서가 더 유연하다. 분석 순서, 출력 형식, 데이터
점검 기준이 자주 바뀌기 때문에 먼저 문서를 조정하면서 실제 사용 흐름을 검증한다.

워크플로우를 너무 일찍 코드에 고정하면 아직 확정되지 않은 단계 구성이 굳어지고, 분석 단계
변경이나 skill 역할 조정이 불필요하게 무거워진다. Pi 런타임을 걷어낸 것도 같은 판단이다 —
TS 도구 계층을 유지하는 비용이 얻는 안정성보다 컸다.

### 나중에 도입할 조건

아래 문제가 반복되면 워크플로우 고정(계산은 cluefin CLI 쪽 명령으로, 순서 강제는 hook이나
별도 도구로)을 검토한다.

- 같은 입력에서도 단계 순서를 자주 건너뛰거나 바꾸는 경우
- 데이터 누락 또는 충돌 시 중단해야 하는데 계속 최종 판단까지 진행하는 경우
- bull, bear, final decision 결과를 구조화해서 저장하거나 비교해야 하는 경우
- 데이터 수집 결과를 캐싱하거나 중간 산출물로 파일에 남겨야 하는 경우
- 여러 provider 결과를 코드 레벨에서 병합, 우선순위 적용, fallback 처리해야 하는 경우

지표 계산처럼 "행이 아니라 결론만 필요한" 연산은 이미 cluefin CLI가 흡수하고 있다
(`kis chart technical`). 같은 성격의 작업은 이 저장소가 아니라 CLI 쪽에 얹는 것을 먼저
검토한다.

## 판단 채점 (decision-scorecard)

`docs/assets/factory_logo.png`에 "Backtest Bot (coming soon)"으로 잡아둔 자리는 두 갈래로
간다. **forward test 채점**이 주 경로이고, **블라인드 backward 테스트**를 병행한다(아래 절).
과거 구간에 에이전트를 그대로 다시 돌리는 방식은 두 가지 이유로 쓰지 않는다.

- point-in-time 재무와 상장폐지 종목 없이는 look-ahead / survivorship bias를 피할 수 없다.
- 모델이 과거 주가 흐름을 이미 알고 있어, 그건 백테스트가 아니라 기억력 테스트가 된다.

forward는 "이 에이전트를 믿어도 되는가"에, 블라인드 backward는 "판단 로직이 작동하는가"에
답한다. 두 표본은 집계에서 섞지 않는다.

대신 `final-decision`이 낸 판단에 타임스탬프와 기한을 박아 저장하고, 기한이 오면
그때의 실제 값과 대조한다. 판단 시점에 결과를 알 수 없었다는 보증이 이 방식의 근거다.

- 스키마: `schemas/final-decision.schema.json` (+ `final-decision.example.md`)
- 발행: `final-decision` → `investment-journal`이 frontmatter째 journal에 저장
- 채점: `scripts/scorecard.mjs`가 산술과 쓰기를 맡고, `decision-scorecard` 스킬은
  실행과 결과 해석만 한다 (`lint` → `score --write` → `aggregate`)

## 블라인드 backward 테스트 + PIT 저장소

종목·날짜를 가리고 가격을 기준일=100으로 바꾼 케이스로 판단을 내리게 한 뒤, 봉인해 둔 실제
값으로 채점한다. 위의 두 이유를 이렇게 다룬다: 기억은 마스킹과 누출 점검(재식별 탐침, 모델
컷오프 전후 비교, 가격 경로를 뒤집은 대조군)으로, look-ahead는 모든 값에 알려진 날을 붙인
PIT 저장소로. 생존 편향은 풀지 못하고 결과에 명시한다.

- **범위는 지금 API로 과거 값을 채울 수 있는 데이터로 한정한다**(2026-09-29 실측): 일봉·
  기술적 지표·지수·수급·공매도, DART 재무(주요계정·주요지표), 공시 목록, 애널리스트 의견.
  매크로(금리는 오늘 값만, 환율 명령 없음)와 뉴스 본문은 뺀다 — `macro-analysis`·
  `news-analysis`는 블라인드에서 돌리지 않는다.
- **DART 주요계정은 정정본만 준다.** 정정 접수일이 기준일보다 늦은 기간은 케이스에서 비운다.
- **순서:** 실험 범위 고정 → 케이스 스키마·마스킹(`scripts/blind/`) → PIT 저장 골격·가격
  캐시(`scripts/pit/`) → 파일럿 30건 → 누출 점검 → 기준선(buy&hold·항상 watch·무작위·룰
  투표)·통계 → 재무·공시·의견 PIT → 본 표본 200건. 케이스 스키마가 PIT의 적재 범위를 정한다.
- **판단 실행기는 격리한다.** 케이스 파일만 읽고 CLI·웹을 못 부르는 서브에이전트여야 한다.
- 착수 전 결정: 유니버스(권고: 기준일에 상장돼 있던 현 상장 종목 중 거래대금 상위), PIT
  저장 형식(권고: JSON 파일, 대안 DuckDB).

## 매매일지·채점 추가 개발

forward 판단을 매매일지로 남기고 기한에 채점하는 흐름에 집중한다. journal은 0건에서 다시
시작한다.

- **forward 판단 발행 재개.** 거래일 20일이면 첫 채점까지 약 한 달, 구간별 10건(집계를
  해석하는 기준선)까지는 몇 달이 걸린다. 표본 수가 아래 모든 항목의 전제다.
- **판단과 실제 매매 연결.** `transactions.csv`(`date,symbol,side,quantity,price,fee,note`)에
  `decision_id`가 없어, 판단을 따라 샀는지·어겼는지·판단 없이 샀는지를 볼 수 없다. 연결
  열을 추가하고 "판단 성과"와 "실행 성과"를 나눠 집계한다.
- **복기 흐름.** `review_due`가 오면 `score` 결과와 함께 journal 본문의 사후 복기 항목을
  채우도록 `investment-journal`·`decision-scorecard`를 잇는다. 감정 기록은 지금처럼
  채점 대상 밖에 둔다.
- **조기 채점.** 무효화 조건의 daily 확인을 자동으로 돌릴지, 요청 시에만 돌릴지 미정.
- **가격 외 술어 평가.** `operating_profit_growth_yoy` 같은 `checkable: true` 술어를
  스크립트가 평가하지 못해 `manual_conditions`로 넘긴다. 최신 실적은 이제
  `dart financial-major-accounts`가 원천이므로 그 경로로 붙인다.
- **평가지표.** 판단 단위 누적수익(CR)·초과수익 IR·최악 역행폭을 기존 `scoring` 필드로
  먼저 내고, 일봉 사이드카를 남겨 고점→저점 MDD·연환산 Sharpe로 넓힌다. 그 밖에 무효화
  조건 효용(조기 종료 대비 기한까지 갔을 때의 손실 차이), `gates.data_sanity` warn 판단의
  초과수익 저하 폭, `skills_run` 구성별 성과 차이. 표본이 쌓이기 전에는 읽을 것이 없다.
- **채점 결과 되먹임.** `aggregate --brief` 요약을 bull/bear/final-decision이 읽고 확신도
  조정에만 쓴다. 표본 10건 미만이면 "해석 불가" 한 줄만 낸다.
- **손절폭 규칙 검증.** `1.5 × ATR14 × √(horizon/30)`은 검증 표본이 없다. 근거였던
  retro seed 3건(종목 1개, 같은 날 발동)은 삭제했고, 20% 캡은 한 번도 걸리지 않았다.
- **`reference.adjusted`** 를 CLI 응답에서 자동으로 판별할 방법이 없다. 지금은 확인 안
  되면 false로 두고 경고만 남긴다.

## 그 밖의 남은 작업

- **분석 파이프라인 개선** (TradingAgents 논문에서 고른 것): bull/bear 재반박 라운드,
  중간 산출물을 run 디렉터리에 파일로 저장, `risk-position-sizing`의 공격·중립·보수 세
  관점. 두 번째는 `market-review` 안에서 서브에이전트를 또 띄울 수 있는지 먼저 확인한다.
- **원격 브랜치 정리.** main 외 11개가 남아 있다. squash 머지된 PR 9개(#13·#23·#24·#27·
  #29·#30·#31·#34·#35)의 브랜치, main에 들어간 `chore/lint-hook-and-plans-dir`, 닫힌 #17의
  `feat/use-agent-browser`(Pi 리소스라 더 쓰지 않는다).

## 데이터 공백

- **원/달러 환율 명령이 없다.** 2026-09-29 `search "환율"`은 0건, `search "exchange rate"`는
  금리·ETF 수익률 명령만 돌려준다. 외국인 수급 해석에 매크로 배경이 빠지므로, cluefin CLI에
  FX 명령을 추가하거나 별도 소스를 정한다.
- 금리 데이터는 국내와 미국 지표의 기준일이 며칠 어긋날 수 있다. 매크로 해석 시 기준일을
  먼저 맞춘다.

## 남은 정리

- dependabot이 `vitest`만 올리고 `@vitest/coverage-v8`은 두어 peer 충돌로
  `npm install`이 깨진 적이 있다(#26). 두 패키지는 버전을 함께 올려야 한다(지금은 둘 다
  4.1.11).

# TODO

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

`docs/assets/factory_logo.png`에 "Backtest Bot (coming soon)"으로 잡아둔 자리는
과거 구간 백테스트가 아니라 **forward test 채점**으로 간다. 과거 구간에 에이전트를 다시
돌리는 방식은 두 가지 이유로 버렸다.

- point-in-time 재무와 상장폐지 종목을 구할 수 없어 look-ahead / survivorship bias를
  피할 방법이 없다.
- 모델이 과거 주가 흐름을 이미 알고 있어, 그건 백테스트가 아니라 기억력 테스트가 된다.

대신 `final-decision`이 낸 판단에 타임스탬프와 기한을 박아 저장하고, 기한이 오면
그때의 실제 값과 대조한다. 판단 시점에 결과를 알 수 없었다는 보증이 이 방식의 근거다.

- 스키마: `schemas/final-decision.schema.json` (+ `final-decision.example.md`)
- 발행: `final-decision` → `investment-journal`이 frontmatter째 journal에 저장
- 채점: `scripts/scorecard.mjs`가 산술과 쓰기를 맡고, `decision-scorecard` 스킬은
  실행과 결과 해석만 한다 (`lint` → `score --write` → `aggregate`)

남은 일:

- 판단 표본이 쌓이기 전까지 집계는 의미가 없다. 구간별 10건이 기준선이다.
- 조기 채점(무효화 조건 daily 확인)을 자동으로 돌릴지, 요청 시에만 돌릴지 미정.
- 벤치마크 지수 조회는 `scripts/lib/cluefin.mjs`가 맡는다. `--start-date`가 종료일인
  함정은 `endingOn`으로 감쌌고, 100행 상한은 `pageBackwards`가 나눠 호출해 병합한다
  (지수·가격 양쪽 모두). 구간이 기준일까지 닿지 않으면 `coverage_gap`으로 표시된다.
- 가격이 아닌 `checkable: true` 술어(`operating_profit_growth_yoy` 등)를 스크립트가
  평가하지 못해 `manual_conditions`로 넘긴다. `kis financial` 경로를 붙일지 정해야 한다.
- 집계에서 아직 안 내는 지표: 무효화 조건 효용(조기 종료 대비 기한까지 갔을 때의 손실
  차이), `gates.data_sanity`가 warn인 판단의 초과수익 저하 폭, `skills_run` 구성별 성과
  차이. 표본이 쌓이기 전에는 계산해도 읽을 것이 없어 미뤘다.
- 손절폭 규칙(`1.5 × ATR14 × √(horizon/30)`)의 검증 표본이 종목 1개·가격경로 1개다.
  long 3건이 전부 같은 날 발동해 독립 증거가 아니고, 20% 캡은 한 번도 걸리지 않았다.
- `reference.adjusted`를 CLI 응답에서 자동으로 판별할 방법이 없다. 지금은 확인 안 되면
  false로 두고 경고만 남긴다.

## 데이터 공백

- **원/달러 환율 명령이 없다.** `list --query "exchange rate"`가 0건이고 `search`도
  금리 명령만 돌려준다. 외국인 수급 해석에 매크로 배경이 빠지므로, cluefin CLI에 FX 명령을
  추가하거나 별도 소스를 정한다.
- **DART 기업코드 조회가 전체 상장사 덤프다.** `dart corp-code-lookup`에 종목 단위 필터가
  없어 한 종목을 보려고 전체 목록을 내려받게 된다. 종목코드 → corp_code 매핑 경로가 필요하다.
- 금리 데이터는 국내와 미국 지표의 기준일이 며칠 어긋날 수 있다. 매크로 해석 시 기준일을
  먼저 맞춘다.

## 남은 정리

- `vitest.config.ts`는 `tests/`를 가리키지만 테스트가 없다. 테스트를 쓸 계획이 없으면
  vitest 설정과 의존성도 정리한다 — 남아 있는 npm 의존성은 biome과 vitest뿐이다.
- dependabot이 `vitest`만 올리고 `@vitest/coverage-v8`은 두어 peer 충돌로
  `npm install`이 깨진 적이 있다(#26). 두 패키지는 버전을 함께 올려야 한다.

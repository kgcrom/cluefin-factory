/**
 * Rewriting the `scoring` block in place.
 *
 * Only that block is touched: re-serialising the whole frontmatter would reorder
 * keys and drop comments, and rewriting a past judgment is what makes a scorecard
 * meaningless in the first place.
 */

const BLOCK = /^scoring:\n(?:[ \t].*\n|\n)*/m;

const scalar = (value) => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

/** Facts only. Interpretation is the skill's job, not the script's. */
export function scoringNotes(result, { referenceDate }) {
  const parts = [];
  if (result.invalidated_by?.length > 0) {
    parts.push(
      `무효화 조건 ${result.invalidated_by.join(', ')} 발동으로 ${result.endDate} 조기 종료.`,
    );
  } else {
    parts.push(`기한 도래 정상 채점(${result.endDate} 종가 기준).`);
  }
  parts.push(`경과 ${result.elapsed_days}일 / horizon 대비 ${result.elapsed_ratio}%.`);
  if (result.early_exit) {
    parts.push('20% 미만이라 horizon별 성과 비교에서 제외한다(적중률 집계에는 포함).');
  }
  if (result.excess_long !== null) {
    parts.push(`excess_long ${result.excess_long}%p.`);
  }
  if (result.within_noise) {
    parts.push(`구간 지수 일간 변동성 ${result.index_volatility_pct}%p를 밑도는 노이즈 범위.`);
  }
  if (result.coverage_gap) {
    parts.push('경고: 조회 구간이 기준일까지 닿지 않는다 — 시계열이 잘렸을 수 있다.');
  }
  if (result.manual_conditions?.length > 0) {
    parts.push(`자동 판정 불가 조건: ${result.manual_conditions.join(', ')} — 사용자 확인 필요.`);
  }
  parts.push(`조회 구간 ${referenceDate}~${result.endDate}.`);
  return parts.join(' ');
}

export function renderScoring(result, { scoredAt, referenceDate }) {
  if (result.status === 'pending') {
    return 'scoring:\n  status: pending\n';
  }
  const lines = [
    'scoring:',
    `  status: ${result.status}`,
    `  scored_at: ${scoredAt}`,
    `  price_at_review: ${scalar(result.price_at_review)}`,
    `  return_pct: ${scalar(result.return_pct)}`,
    `  benchmark_return_pct: ${scalar(result.benchmark_return_pct)}`,
    `  max_drawdown_pct: ${scalar(result.max_drawdown_pct)}`,
    `  stop_hit: ${scalar(result.stop_hit)}`,
    `  target_hit: ${scalar(result.target_hit)}`,
    `  invalidated_by: ${JSON.stringify(result.invalidated_by ?? [])}`,
    `  outcome: ${scalar(result.outcome)}`,
    '  notes: >-',
    ...wrap(scoringNotes(result, { referenceDate }), 88).map((line) => `    ${line}`),
  ];
  return `${lines.join('\n')}\n`;
}

function wrap(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line.length + word.length + 1 > width && line.length > 0) {
      out.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) out.push(line);
  return out;
}

/** Replace the `scoring` block of a journal entry's text. */
export function applyScoring(text, block) {
  if (!BLOCK.test(text)) throw new Error('scoring 블록을 찾지 못했다');
  return text.replace(BLOCK, block.endsWith('\n') ? block : `${block}\n`);
}

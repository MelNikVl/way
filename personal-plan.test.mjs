import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPersonalPlan, personalIncomeProgress } from './personal-plan.mjs';

const date = key => new Date(`${key}T12:00:00`);
const state = () => ({
  startedAt: '2026-09-30',
  profile: { currency: 'USD', goalKind: 'capital', goalScope: 'family', goalAmount: 500000, goalDate: '2031-09-30', dailyMinutes: 45, income: 3000, expenses: null, assets: null, debts: 0 },
  answers: {}, finances: {},
});
const context = () => ({
  seedProfile: { goalScope: 'family' },
  assetDraft: { currency: 'RUB', items: [{ amount: 8000000 }, { amount: 2000000 }] },
  valuation: { fxRate: 100, fxDate: '2026-09-30', sourceUrl: 'https://example.com/reference', planStartDate: '2026-09-30' },
  findings: [{ title: 'Подтверждённый источник', detail: 'Исторический опыт требует уточнения.', url: 'https://example.com/private' }],
});
const build = (s = state(), c = context(), d = '2026-09-30') => buildPersonalPlan(s, c, date(d));

test('a dated reference converts RUB assets once and never invents expenses or savings', () => {
  const result = build();
  assert.equal(result.financial.source, 'reference-fx');
  assert.equal(result.financial.startingCapital, 100000);
  assert.equal(result.financial.goalGap, 400000);
  assert.equal(result.financial.expenses, null);
  assert.equal(result.financial.monthlySurplus, null);
  assert.equal(result.financial.knownIncome, 3000);
  assert.equal(result.financial.annualCheckpoints[0].requiredNetIncome, null);
  assert.equal(result.financial.monthsRemaining, 60);
  assert.equal(result.financial.totalMonths, 60);
  assert.equal(result.financial.fxDate, '2026-09-30');
});

test('five annual stages use cumulative shares and incremental phase contributions', () => {
  const s = state(); s.profile.expenses = 2500;
  const points = build(s).financial.annualCheckpoints;
  assert.deepEqual(points.map(x => x.due), ['2027-09-30', '2028-09-30', '2029-09-30', '2030-09-30', '2031-09-30']);
  assert.deepEqual(points.map(x => x.capitalTarget), [120000, 160000, 240000, 360000, 500000]);
  assert.deepEqual(points.map(x => x.requiredMonthlySurplus), [1666.67, 3333.33, 6666.67, 10000, 11666.67]);
  assert.equal(points[0].requiredNetIncome, 4166.67);
  assert.equal(build(s).milestones.find(x => x.horizon === 'halfyear').capitalTarget, 110000);
});

test('daily and monthly updates cannot move baseline dates or capital targets', () => {
  const s = state(), initial = build(s);
  s.finances['2027-09'] = { income: 6000, expenses: 2000, assets: 130000, debts: 0 };
  const later = build(s, context(), '2027-09-30');
  assert.equal(later.planStartDate, initial.planStartDate);
  assert.equal(later.financial.startingCapital, initial.financial.startingCapital);
  assert.deepEqual(later.financial.annualCheckpoints.map(x => [x.due, x.capitalTarget]), initial.financial.annualCheckpoints.map(x => [x.due, x.capitalTarget]));
  assert.equal(later.financial.currentCapital, 130000);
  assert.equal(later.financial.currentCapitalDate, '2027-09');
  assert.equal(later.financial.monthsRemaining, 48);
  assert.equal(later.financial.monthlySurplus, 4000);
});

test('explicit paired USD baseline overrides reference and allows negative net capital', () => {
  const s = state(); s.answers = { planStartingCapital: '-5000', planStartDate: '2026-08-31' };
  const p = build(s);
  assert.equal(p.financial.source, 'explicit-usd');
  assert.equal(p.financial.startingCapital, -5000);
  assert.equal(p.financial.goalGap, 505000);
  assert.equal(p.planStartDate, '2026-08-31');
  assert.equal(p.financial.fxRate, null);
  s.answers.planStartDate = '';
  assert.equal(build(s).financial.startingCapital, null);
});

test('fixed profile assets and explicit zero liabilities override the RUB draft', () => {
  const s = state(); s.profile.assets = 0;
  let p = build(s);
  assert.equal(p.financial.startingCapital, 0);
  assert.equal(p.financial.source, 'profile-usd');
  s.profile.debts = null;
  assert.equal(build(s).financial.startingCapital, null);
  s.profile.assets = null;
  assert.equal(build(s).financial.startingCapital, null);
});

test('an explicit USD baseline corrects an old profile value while preserving its declared date', () => {
  const s = state(); s.profile.assets = 200000;
  s.answers = { planStartingCapital: '100000', planStartDate: '2026-09-29' };
  const p = build(s);
  assert.equal(p.financial.startingCapital, 100000);
  assert.equal(p.financial.currentCapital, 100000);
  assert.equal(p.planStartDate, '2026-09-29');
  s.answers = {}; s.startedAt = '2026-08-31';
  assert.equal(build(s).planStartDate, '2026-08-31');
});

test('FX requires a dated explicit source and a partial user override does not silently fallback', () => {
  const s = state(), c = context(); delete c.valuation;
  assert.equal(build(s, c).financial.startingCapital, null);
  s.answers = { planFxRate: '80,0', planFxDate: '2026-09-29' };
  let p = build(s, c);
  assert.equal(p.financial.startingCapital, 125000);
  assert.equal(p.financial.source, 'user-fx');
  for (const overrides of [
    { planFxRate: '0', planFxDate: '2026-09-30' },
    { planFxRate: '80', planFxDate: '' },
    { planFxRate: '', planFxDate: '2026-09-30' },
    { planFxRate: '80', planFxDate: '2026-10-01' },
    { planFxRate: '80', planFxDate: '2026-02-30' },
    { planFxRate: 'Infinity', planFxDate: '2026-09-30' },
  ]) { s.answers = overrides; assert.equal(build(s).financial.startingCapital, null, JSON.stringify(overrides)); }
});

test('currency and ownership scope cannot be mixed with the family RUB draft', () => {
  const s = state(); s.profile.currency = 'RUB';
  assert.equal(build(s).financial.eligible, false);
  assert.equal(build(s).financial.startingCapital, null);
  s.profile.currency = 'USD'; s.profile.goalScope = 'personal';
  assert.equal(build(s).financial.startingCapital, null);
  s.profile.goalScope = 'family'; const c = context(); c.assetDraft.currency = 'KZT';
  assert.equal(build(s, c).financial.startingCapital, null);
  c.assetDraft.currency = 'RUB'; c.assetDraft.items[0].amount = null;
  assert.equal(build(s, c).financial.startingCapital, null);
});

test('zero expenses, zero income and unknown values remain distinct', () => {
  const s = state(); s.profile.expenses = 0; s.profile.income = 0;
  let p = build(s);
  assert.equal(p.financial.monthlySurplus, 0);
  assert.equal(p.financial.annualCheckpoints[0].requiredNetIncome, p.financial.annualCheckpoints[0].requiredMonthlySurplus);
  s.profile.expenses = null;
  assert.equal(build(s).financial.monthlySurplus, null);
  s.finances['2026-09'] = { income: 0, expenses: 100, assets: null, debts: 0 };
  p = build(s);
  assert.equal(p.financial.monthlySurplus, -100);
  assert.equal(p.financial.currentCapital, null);
  assert.equal(p.financial.startingCapital, 100000);
});

test('variable deadlines scale stage dates and calendar months honor month-end and leap dates', () => {
  const s = state(); s.profile.goalDate = '2029-03-30';
  const p = build(s);
  assert.equal(p.financial.totalMonths, 30);
  assert.deepEqual(p.financial.annualCheckpoints.map(x => x.due), ['2027-03-30', '2027-09-30', '2028-03-30', '2028-09-30', '2029-03-30']);
  assert.equal(p.milestones.at(-1).due, '2029-03-30');
  s.answers = { planStartingCapital: '0', planStartDate: '2028-01-31' };
  s.profile.goalDate = '2028-02-29';
  const leap = build(s, context(), '2028-01-31');
  assert.equal(leap.financial.totalMonths, 1);
  assert.equal(leap.financial.monthsRemaining, 1);
  assert.equal(leap.milestones[1].due, '2028-02-29');
  assert.equal(leap.financial.annualCheckpoints.at(-1).due, '2028-02-29');
});

test('near deadlines use fractional months and passed deadlines never divide by zero', () => {
  const s = state(); s.profile.goalDate = '2026-10-01';
  const near = build(s);
  assert.ok(near.financial.monthsRemaining > 0 && near.financial.monthsRemaining < 1);
  assert.ok(near.financial.remainingRequiredMonthlySurplus > near.financial.goalGap);
  assert.ok(near.financial.annualCheckpoints.every(x => x.requiredMonthlySurplus === null || Number.isFinite(x.requiredMonthlySurplus)));
  assert.equal(near.financial.annualCheckpoints.length, 1);
  assert.equal(near.financial.annualCheckpoints[0].capitalTarget, 500000);
  assert.ok(near.financial.annualCheckpoints[0].requiredMonthlySurplus > near.financial.goalGap);
  const passed = build(s, context(), '2026-10-02');
  assert.equal(passed.financial.monthsRemaining, 0);
  assert.equal(passed.financial.remainingRequiredMonthlySurplus, null);
  s.profile.goalDate = '2026-09-29';
  assert.deepEqual(build(s).financial.annualCheckpoints, []);
});

test('achieved capital never implies a negative saving requirement', () => {
  const s = state(); s.profile.assets = 600000; s.profile.expenses = 1000;
  const p = build(s);
  assert.equal(p.financial.goalGap, 0);
  assert.equal(p.financial.averageRequiredMonthlySurplus, 0);
  assert.ok(p.financial.annualCheckpoints.every(x => x.requiredMonthlySurplus === 0));
});

test('focus choice and explicit next step are respected without mining prose for psychological traits', () => {
  const s = state(); s.answers = { focusDirection: 'career', planNextStep: 'Обновить один кейс.', joy: 'Очень люблю продукты' };
  const p = build(s);
  assert.equal(p.focus.direction, 'career');
  assert.equal(p.focus.chosenByUser, true);
  assert.equal(p.focus.isHypothesis, true);
  assert.equal(p.milestones[0].action, 'Обновить один кейс.');
  assert.ok(p.milestones.every(x => /^personal-career-/.test(x.id)));
  delete s.answers.focusDirection;
  assert.equal(build(s).focus.direction, 'service');
  assert.equal(build(s).focus.chosenByUser, false);
});

test('manually reviewed context selects a product route without parsing free-text answers', () => {
  const s = state(), c = context();
  s.answers.next_step = 'Старый ответ в общей анкете.';
  c.currentPlan = { direction: 'product', reason: 'Направление согласовано по новым ответам.', nextStep: 'Составить список покупателей.', facts: [] };
  const p = build(s, c);
  assert.equal(p.focus.direction, 'product');
  assert.equal(p.focus.chosenByUser, false);
  assert.equal(p.focus.reason, c.currentPlan.reason);
  assert.equal(p.focus.nextStep, c.currentPlan.nextStep);
  assert.equal(p.milestones[0].action, c.currentPlan.nextStep);
  assert.ok(p.milestones.every(x => x.id.startsWith('personal-product-')));
  assert.ok(p.milestones[1].acceptance.some(x => x.includes('письменное намерение') && x.includes('оплата')));
});

test('explicit direction overrides a reviewed route and rejects its mismatched reason and action', () => {
  const s = state(), c = context();
  s.answers.focusDirection = 'career';
  c.currentPlan = { direction: 'product', reason: 'Причина только для продукта.', nextStep: 'Действие только для продукта.' };
  const p = build(s, c);
  assert.equal(p.focus.direction, 'career');
  assert.equal(p.focus.chosenByUser, true);
  assert.notEqual(p.focus.reason, c.currentPlan.reason);
  assert.notEqual(p.focus.nextStep, c.currentPlan.nextStep);
  s.answers.planNextStep = 'Мой явно выбранный шаг.';
  assert.equal(build(s, c).focus.nextStep, s.answers.planNextStep);
});

test('matching reviewed content enriches an explicit choice while its explicit next step still wins', () => {
  const s = state(), c = context();
  s.answers = { focusDirection: 'product', planNextStep: 'Действие из настроек.' };
  c.currentPlan = { direction: 'product', reason: 'Проверенная персональная причина.', nextStep: 'Рекомендованное действие.' };
  const p = build(s, c);
  assert.equal(p.focus.reason, c.currentPlan.reason);
  assert.equal(p.focus.nextStep, s.answers.planNextStep);
  assert.equal(p.focus.chosenByUser, true);
  c.currentPlan.direction = 'unsupported';
  delete s.answers.focusDirection;
  assert.equal(build(s, c).focus.direction, 'service');
});

test('reviewed facts append to source facts as detached values without mutating either input', () => {
  const s = state(), c = context();
  c.currentPlan = { direction: 'product', facts: [{ title: 'Новый подтверждённый факт', detail: 'Ручное обобщение ответа.' }, { title: 'Факт со ссылкой', detail: 'Контекст.', url: 'https://example.com/new' }] };
  const before = JSON.stringify({ s, c });
  const p = build(s, c);
  assert.equal(JSON.stringify({ s, c }), before);
  assert.equal(p.factBasis.length, c.findings.length + c.currentPlan.facts.length);
  assert.deepEqual(p.factBasis[1], { title: 'Новый подтверждённый факт', detail: 'Ручное обобщение ответа.', url: '' });
  p.factBasis[1].title = 'Изменено только в результате';
  assert.equal(c.currentPlan.facts[0].title, 'Новый подтверждённый факт');
});

test('the function is pure and private facts are returned only from provided context', () => {
  const s = state(), c = context(), original = JSON.stringify({ s, c });
  const p = build(s, c);
  assert.equal(JSON.stringify({ s, c }), original);
  assert.deepEqual(p.factBasis, c.findings);
  p.factBasis[0].title = 'Changed';
  assert.equal(c.findings[0].title, 'Подтверждённый источник');
  assert.deepEqual(build(s, null).factBasis, []);
  assert.equal(build(s, null).financial.startingCapital, null);
  assert.throws(() => buildPersonalPlan(s, c, new Date('invalid')));
});

function coaching() {
  return {
    reviewedAt: '2026-09-30', summary: 'A reviewed experiment.',
    incomeCheckpoints: [{ id: 'income-week', horizon: 'week', due: '2026-10-07', title: 'Test the offer',
      targetIncome: { amount: 0, currency: 'USD', scope: 'personal', period: 'month', basis: 'net' },
      criteria: ['Have one useful conversation.'], action: 'Write one invitation.' }],
    weeklyRhythm: [{ day: 1, title: 'Rest', minutes: 0, action: 'Keep the day free.', minimum: 'Pause.', output: 'Recovery.' }],
    habitPrescriptions: [{ id: 'coach-market', title: 'One useful action', cue: 'After breakfast', minimum: 'Open the draft', target: 3, why: 'Make starting easier.' }],
    metrics: [{ id: 'market', label: 'Conversations', baseline: 'Not measured', target: 'One per week', measurement: 'Count completed conversations', frequency: 'Weekly' }],
    reviewRules: ['Review actual results.'], safeguards: ['Stay within the agreed time budget.'],
  };
}
function coached(raw = coaching(), s = state()) {
  const c = context(); c.currentPlan = { direction: 'product', coaching: raw };
  return build(s, c);
}

test('reviewed coaching is detached display data; explicit zero and unknown income are preserved', () => {
  const raw = coaching(), s = state(), before = JSON.stringify({ raw, s });
  const p = coached(raw, s);
  assert.deepEqual(p.coaching, raw);
  assert.equal(p.coaching.incomeCheckpoints[0].targetIncome.amount, 0);
  assert.equal(p.coaching.weeklyRhythm[0].minutes, 0);
  assert.equal(p.financial.expenses, null);
  assert.equal(JSON.stringify({ raw, s }), before);
  p.coaching.incomeCheckpoints[0].criteria.push('Changed in returned result only');
  p.coaching.habitPrescriptions[0].title = 'Changed';
  assert.equal(raw.incomeCheckpoints[0].criteria.length, 1);
  assert.equal(raw.habitPrescriptions[0].title, 'One useful action');
  raw.incomeCheckpoints[0].targetIncome = null;
  assert.equal(coached(raw).coaching.incomeCheckpoints[0].targetIncome, null);
});

test('coaching rejects malformed or incomplete rows without manufacturing numbers or observations', () => {
  const raw = coaching();
  raw.reviewedAt = '2026-02-30';
  raw.incomeCheckpoints.push({ ...raw.incomeCheckpoints[0], id: 'bad-date', due: '2026-02-30' });
  raw.incomeCheckpoints[0].targetIncome = { amount: '500', currency: 'USD' };
  raw.weeklyRhythm.push({ day: 2, title: 'Incomplete' }, { day: 8, title: 'Invalid', action: 'Nothing', minutes: 20 });
  raw.habitPrescriptions.push({ id: 'constructor', title: 'Invalid', cue: 'Now', minimum: 'Open', target: 2 }, { id: 'too-often', title: 'Invalid', cue: 'Now', minimum: 'Open', target: 8 });
  raw.metrics[0].baseline = 0; raw.metrics[0].target = { score: 10 };
  raw.metrics.push({ id: 'missing', label: 'No measurement' });
  raw.reviewRules = [null, 0, '', '  Keep this  '];
  const p = coached(raw).coaching;
  assert.equal(p.reviewedAt, null);
  assert.equal(p.incomeCheckpoints.length, 1);
  assert.equal(p.incomeCheckpoints[0].targetIncome, null);
  assert.equal(p.weeklyRhythm.length, 1);
  assert.equal(p.habitPrescriptions.length, 1);
  assert.equal(p.metrics.length, 1);
  assert.equal(p.metrics[0].baseline, '');
  assert.equal(p.metrics[0].target, '');
  assert.deepEqual(p.reviewRules, ['Keep this']);
});

test('coaching bounds text and arrays, deduplicates identities, and allows only display fields', () => {
  const raw = coaching(), checkpoint = raw.incomeCheckpoints[0], habit = raw.habitPrescriptions[0], metric = raw.metrics[0];
  raw.summary = 'x'.repeat(2500);
  raw.incomeCheckpoints = Array.from({ length: 9 }, (_, i) => ({ ...checkpoint, id: `checkpoint-${i}` }));
  raw.weeklyRhythm = [{ ...raw.weeklyRhythm[0] }, ...Array.from({ length: 8 }, (_, i) => ({ ...raw.weeklyRhythm[0], day: i + 1 }))];
  raw.habitPrescriptions = [habit, habit, { ...habit, id: 'second' }, { ...habit, id: 'third' }];
  raw.metrics = Array.from({ length: 12 }, (_, i) => ({ ...metric, id: `metric-${i}` }));
  raw.safeguards = Array(12).fill('x');
  const html = '<img src=x onerror=alert(1)>';
  raw.incomeCheckpoints[0].title = html;
  raw.incomeCheckpoints[0].html = html;
  raw.habitPrescriptions[0].active = true;
  raw.untrustedHTML = html;
  const p = coached(raw).coaching;
  assert.equal(p.summary.length, 2000);
  assert.equal(p.incomeCheckpoints.length, 5);
  assert.equal(p.weeklyRhythm.length, 7);
  assert.equal(p.habitPrescriptions.length, 2);
  assert.equal(p.metrics.length, 8);
  assert.equal(p.safeguards.length, 8);
  // Text is kept literal for the UI's esc(); no raw HTML property reaches it.
  assert.equal(p.incomeCheckpoints[0].title, html);
  assert.equal('html' in p.incomeCheckpoints[0], false);
  assert.equal('untrustedHTML' in p, false);
  assert.equal('active' in p.habitPrescriptions[0], false);
});

test('coaching belongs only to its reviewed direction and never reads free-text answers as code', () => {
  const s = state(); s.answers.focusDirection = 'career';
  assert.equal(coached(coaching(), s).coaching, null);
  s.answers.focusDirection = 'product';
  assert.ok(coached(coaching(), s).coaching);
  for (const invalid of [null, 'text', [], 1]) assert.equal(coached(invalid).coaching, null);
  assert.equal(build().coaching, null);
  assert.deepEqual(coached({}).coaching, { reviewedAt: null, summary: '', incomeCheckpoints: [], weeklyRhythm: [], habitPrescriptions: [], metrics: [], reviewRules: [], safeguards: [] });
});

test('personal income stays unknown without three full months and never inherits family figures', () => {
  const s = state(); s.profile.income = 9000; s.finances['2026-08'] = { income: 10000 };
  s.answers = { personalIncome_USD_2026_08: '100', 'personalIncome_USD_2026-06': '', 'personalIncome_USD_2026-07': 'unknown',
    'personalIncome_USD_2026-08': '0', 'personalIncome_USD_2026-09': '250' };
  const before = JSON.stringify(s);
  const result = personalIncomeProgress(s, 'USD', date('2026-09-30'));
  assert.deepEqual(result.periodMonths, ['2026-06', '2026-07', '2026-08']);
  assert.equal(result.observationCount, 1);
  assert.equal(result.threeMonthAverage, null);
  assert.equal(result.latestMonth, '2026-09');
  assert.equal(result.latestAmount, 250);
  assert.deepEqual(result.records, [{ month: '2026-09', amount: 250 }, { month: '2026-08', amount: 0 }]);
  assert.equal(JSON.stringify(s), before);
  const empty = personalIncomeProgress({}, 'USD', date('2026-09-30'));
  assert.equal(empty.latestMonth, null); assert.equal(empty.latestAmount, null); assert.equal(empty.observationCount, 0);
});

test('personal income average uses only previous full months across a new year, including real zeros', () => {
  const s = { answers: { 'personalIncome_USD_2025-10': '0', 'personalIncome_USD_2025-11': '150',
    'personalIncome_USD_2025-12': '300.50', 'personalIncome_USD_2026-01': '99000',
    'personalIncome_USD_2026-02': '50000', 'personalIncome_USD_2025-09': '25' } };
  const result = personalIncomeProgress(s, 'USD', date('2026-01-01'));
  assert.deepEqual(result.periodMonths, ['2025-10', '2025-11', '2025-12']);
  assert.equal(result.observationCount, 3);
  assert.equal(result.threeMonthAverage, 150.17);
  assert.equal(result.latestAmount, 99000);
  assert.equal(result.records.length, 5);
  assert.equal(result.records.some(item => item.month === '2026-02'), false);
});

test('personal income currencies are independent and invalid numeric or month values remain unknown', () => {
  const s = { answers: { 'personalIncome_USD_2026-08': '1000000000000', 'personalIncome_KZT_2026-08': '0',
    'personalIncome_RUB_2026-08': '250,75', 'personalIncome_USD_2026-07': '-1',
    'personalIncome_USD_2026-06': '1000000000001', 'personalIncome_USD_2026-05': 200,
    'personalIncome_USD_2026-04': 'Infinity', 'personalIncome_USD_2026-13': '5',
    'personalIncome_USD_2026-00': '5', 'personalIncome_USD_2026-1': '5', 'personalIncome_EUR_2026-09': '500' } };
  const now = date('2026-09-30');
  const usd = personalIncomeProgress(s, 'USD', now);
  assert.deepEqual(usd.records, [{ month: '2026-08', amount: 1e12 }]);
  assert.equal(personalIncomeProgress(s, 'KZT', now).latestAmount, 0);
  assert.equal(personalIncomeProgress(s, 'RUB', now).latestAmount, 250.75);
  assert.throws(() => personalIncomeProgress(s, 'EUR', now), TypeError);
  assert.throws(() => personalIncomeProgress(s, 'USD', new Date('invalid')), TypeError);
});

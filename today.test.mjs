import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultState } from './core.mjs';
import { questionGroups } from './content.mjs';
import { buildToday } from './today.mjs';

const date = key => new Date(`${key}T12:00:00`);
function fixture() {
  const state = defaultState(); state.startedAt = '2026-09-30'; state.profile.dailyMinutes = 45;
  state.answers = Object.fromEntries(questionGroups.flatMap(group => group.questions).map(([key]) => [key, 'An answer']));
  const context = { valuation: { planStartDate: '2026-09-30' }, currentPlan: { direction: 'product', coaching: {
    weeklyRhythm: Array.from({ length: 7 }, (_, index) => ({ day: index + 1, title: `Day ${index + 1}`, action: `Action ${index + 1}`,
      minutes: 30, minimum: `Minimum ${index + 1}`, output: `Result ${index + 1}` })),
  } }, householdBudget: { rentalCostsRub: null } };
  return { state, context };
}
function review() {
  return { version: 1, status: 'accepted', sourceRevision: 1, author: 'Reviewer', generatedAt: date('2026-09-30').toISOString(),
    actions: [{ date: '2026-09-30', title: 'Reviewed action', action: 'Talk to one buyer', minutes: 20, minimum: 'Write one name', doneWhen: 'One invitation sent' }], questions: [] };
}

test('first week follows anchored days once, respects low time budget, and never reopens 56 answered questions', () => {
  const { state, context } = fixture(); state.profile.dailyMinutes = 5;
  const before = JSON.stringify({ state, context });
  const result = buildToday(state, context, { today: date('2026-10-01') });
  assert.equal(result.task.key, 'today-step-2026-10-01');
  assert.equal(result.task.title, 'Day 2');
  assert.equal(result.task.minutes, 5);
  assert.equal(result.task.action, 'Minimum 2');
  assert.equal(result.task.completed, false);
  assert.equal(result.task.source, 'plan');
  assert.equal(result.pending.some(item => item.target === 'questions'), false);
  assert.ok(result.pending.length <= 3);
  assert.deepEqual(result.pending.map(item => item.target), ['checkin', 'income', 'budget']);
  assert.equal(JSON.stringify({ state, context }), before);
  const later = buildToday(state, context, { today: date('2026-10-07') });
  assert.notEqual(later.task.title, 'Day 1');
  assert.equal(later.week.needsPlanReview, true);
  assert.equal(later.week.reviewDue, true);
});

test('step completions and wellbeing are independent; real zero scores remain known', () => {
  const { state, context } = fixture();
  state.milestones['today-step-2026-09-30'] = true;
  state.milestones['today-step-2026-10-01'] = true;
  state.milestones['today-step-2026-10-06'] = true; // Future must not count.
  let result = buildToday(state, context, { today: date('2026-10-01') });
  assert.equal(result.task.completed, true);
  assert.equal(result.week.completed, 2);
  assert.equal(result.week.elapsed, 2);
  assert.equal(result.pending[0].target, 'checkin');
  assert.ok(result.summary[1].includes('пока не отмечены'));
  state.entries['2026-10-01'] = { mood: 0, energy: 0 };
  result = buildToday(state, context, { today: date('2026-10-01') });
  assert.equal(result.pending.some(item => item.target === 'checkin'), false);
  assert.ok(result.summary[1].includes('настроение 0/10 и энергия 0/10'));
  state.entries['2026-10-01'].energy = null;
  result = buildToday(state, context, { today: date('2026-10-01') });
  assert.ok(result.pending[0].detail.includes('энергию'));
  assert.ok(!result.pending[0].detail.includes('настроение'));
});

test('weekly review starts after seven days and a real recent review suppresses repeated requests', () => {
  const { state, context } = fixture();
  assert.equal(buildToday(state, context, { today: date('2026-10-06') }).week.reviewDue, false);
  assert.equal(buildToday(state, context, { today: date('2026-10-07') }).week.reviewDue, true);
  state.reviews['2026-10-07'] = { win: '', next: '', satisfaction: null, conversations: null };
  assert.equal(buildToday(state, context, { today: date('2026-10-07') }).week.reviewDue, true);
  state.reviews['2026-10-07'] = { win: 'One useful result', next: 'Send the revised offer' };
  let result = buildToday(state, context, { today: date('2026-10-13') });
  assert.equal(result.week.reviewDue, false);
  assert.equal(result.task.action, 'Send the revised offer');
  result = buildToday(state, context, { today: date('2026-10-14') });
  assert.equal(result.week.reviewDue, true);
  assert.equal(result.week.lastReviewDate, '2026-10-07');
  state.reviews['2026-12-01'] = { next: 'Future review' };
  assert.equal(buildToday(state, context, { today: date('2026-10-14') }).week.lastReviewDate, '2026-10-07');
});

test('income asks for the previous full month and budget accepts explicit zero without mixing family totals', () => {
  const { state, context } = fixture(); state.entries['2027-01-02'] = { mood: 7, energy: 6 };
  state.reviews['2027-01-01'] = { next: 'Next step' };
  state.profile.income = 10000;
  let result = buildToday(state, context, { today: date('2027-01-02') });
  assert.equal(result.pending.find(item => item.target === 'income').month, '2026-12');
  assert.equal(result.pending.find(item => item.target === 'budget').month, '2026-12');
  state.answers['personalIncome_USD_2026-12'] = '0';
  state.answers.budgetRentalCostsRub = '0'; state.answers.budgetCostsMonth = '2026-12';
  result = buildToday(state, context, { today: date('2027-01-02') });
  assert.equal(result.pending.some(item => item.target === 'income' || item.target === 'budget'), false);
  state.answers.budgetCostsMonth = '2027-02';
  assert.ok(buildToday(state, context, { today: date('2027-01-02') }).pending.some(item => item.target === 'budget'));
  context.householdBudget.rentalCostsRub = 0;
  assert.equal(buildToday(state, context, { today: date('2027-01-02') }).pending.some(item => item.target === 'budget'), false);
});

test('only current accepted AI advice for the exact date replaces the daily task', () => {
  const { state, context } = fixture(), ai = review(), today = date('2026-09-30');
  let result = buildToday(state, context, { today, aiReview: ai });
  assert.equal(result.task.source, 'ai'); assert.equal(result.task.title, 'Reviewed action');
  assert.equal(result.task.doneWhen, 'One invitation sent');
  ai.sourceRevision = 0; // New observations do not invalidate accepted advice.
  assert.equal(buildToday(state, context, { today, aiReview: ai }).task.source, 'ai');
  ai.status = 'draft'; assert.equal(buildToday(state, context, { today, aiReview: ai }).task.source, 'plan');
  ai.status = 'accepted'; ai.generatedAt = date('2026-10-01').toISOString();
  assert.equal(buildToday(state, context, { today, aiReview: ai }).task.source, 'plan');
  ai.generatedAt = date('2026-09-22').toISOString();
  assert.equal(buildToday(state, context, { today, aiReview: ai }).task.source, 'plan');
  ai.generatedAt = today.toISOString(); ai.actions[0].date = '2026-10-01';
  assert.equal(buildToday(state, context, { today, aiReview: ai }).task.source, 'plan');
});

test('required unanswered AI questions follow check-in and exclude answered or unsafe IDs', () => {
  const { state, context } = fixture(), ai = review();
  ai.questions = [
    { id: 'buyer', question: 'Which buyer?', reason: 'To choose the next step', required: true },
    { id: 'size', question: 'What scope?', reason: 'To keep it small', required: true },
    { id: 'optional', question: 'Anything else?', reason: '', required: false },
    { id: '<unsafe>', question: 'Unsafe', reason: '', required: true },
    { id: 'answered', question: 'Answered', reason: '', required: true },
  ];
  state.answers.ai_answered = 'Already answered';
  const result = buildToday(state, context, { today: date('2026-09-30'), aiReview: ai });
  assert.deepEqual(result.pending.map(item => item.target), ['checkin', 'ai-question', 'ai-question']);
  assert.equal(result.pending[1].answerKey, 'ai_buyer');
  assert.equal(result.pending[1].questionId, 'buyer');
  assert.equal(result.summary.length, 3);
  state.answers.ai_buyer = 'Known buyer'; state.answers.ai_size = 'One small task';
  const next = buildToday(state, context, { today: date('2026-09-30'), aiReview: ai });
  assert.equal(next.pending.some(item => item.required), false);
});

test('a completed day retains its original task when new AI advice arrives, or stays neutral without a valid snapshot', () => {
  const { state, context } = fixture(), today = date('2026-09-30'), ai = review();
  const original = buildToday(state, context, { today }).task;
  const { title, action, minutes, minimum, doneWhen, source } = original;
  state.answers['todayTask_2026-09-30'] = JSON.stringify({ title, action, minutes, minimum, doneWhen, source });
  state.milestones['today-step-2026-09-30'] = true;
  const before = JSON.stringify(state);
  let result = buildToday(state, context, { today, aiReview: ai });
  assert.equal(result.task.completed, true);
  assert.equal(result.task.title, original.title);
  assert.equal(result.task.action, original.action);
  assert.equal(result.task.source, 'plan');
  assert.equal(JSON.stringify(state), before);
  for (const invalid of [undefined, '{invalid', '{}', JSON.stringify({ title: 'Incomplete' }), JSON.stringify({ title, action, minutes: -1, minimum, doneWhen, source })]) {
    state.answers['todayTask_2026-09-30'] = invalid;
    result = buildToday(state, context, { today, aiReview: ai });
    assert.equal(result.task.title, 'Основной шаг сегодня выполнен');
    assert.equal(result.task.minutes, null);
    assert.notEqual(result.task.action, ai.actions[0].action);
  }
  state.milestones['today-step-2026-09-30'] = false;
  result = buildToday(state, context, { today, aiReview: ai });
  assert.equal(result.task.title, 'Reviewed action');
  assert.equal(result.task.source, 'ai');
});

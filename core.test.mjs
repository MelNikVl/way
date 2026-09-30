import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY, defaultState, dateKey, currentWeekDates, validateImport, metrics, projection } from './core.mjs';

const day = (year, month, date) => new Date(year, month - 1, date, 12);
const stateAt = startedAt => ({ ...defaultState(), startedAt });
const completeRecord = { income: 300, expenses: 200, assets: 500, debts: 100, liquidAssets: 150 };

test('defaults are independent and serialize into valid versioned backups', () => {
  const first = defaultState();
  const second = defaultState();
  first.habitPlans[0].title = 'Изменено';
  assert.notEqual(first.habitPlans[0].title, second.habitPlans[0].title);
  assert.equal(STORAGE_KEY, 'small-steps-v1');
  assert.deepEqual(validateImport(JSON.stringify(second)), second);
  assert.equal(second.profile.income, null);
});

test('local date windows cross year and leap-day boundaries without missing dates', () => {
  assert.equal(dateKey(day(2026, 1, 1)), '2026-01-01');
  assert.deepEqual(currentWeekDates(day(2026, 1, 2)), ['2025-12-27', '2025-12-28', '2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02']);
  assert.ok(currentWeekDates(day(2028, 3, 1)).includes('2028-02-29'));
  assert.throws(() => dateKey(new Date('invalid')));
});

test('import preserves zero values, fills omitted optional fields, and detaches references', () => {
  const source = { version: 1, profile: { income: 0 }, entries: { '2026-09-30': { mood: 0, focusMinutes: 0 } }, answers: { values: 'Семья и самостоятельность' } };
  const result = validateImport(source);
  assert.equal(result.profile.income, 0);
  assert.equal(result.profile.expenses, null);
  assert.equal(result.entries['2026-09-30'].mood, 0);
  assert.equal(result.entries['2026-09-30'].energy, null);
  source.answers.values = 'Changed';
  assert.equal(result.answers.values, 'Семья и самостоятельность');
});

test('goal scope defaults to personal for older backups and preserves explicit family scope', () => {
  assert.equal(defaultState().profile.goalScope, 'personal');
  assert.equal(validateImport({ version: 1, profile: { goalKind: 'capital' } }).profile.goalScope, 'personal');
  assert.equal(validateImport({ version: 1, profile: { goalScope: 'family' } }).profile.goalScope, 'family');
  assert.equal(validateImport({ version: 1, profile: { goalScope: 'personal' } }).profile.goalScope, 'personal');
  for (const goalScope of ['business', '', null, 0, {}, ['family']]) {
    assert.throws(() => validateImport({ version: 1, profile: { goalScope } }));
  }
});

test('partial daily records from habit clicks and check-in forms both round-trip', () => {
  const source = {
    version: 1,
    entries: {
      '2026-09-29': { habits: { focus: true } },
      '2026-09-30': { mood: 0, energy: null, meaning: null, sleep: 7.5, focusMinutes: 0, note: 'x'.repeat(10_000) },
    },
  };
  const result = validateImport(source);
  assert.equal(result.entries['2026-09-29'].mood, null);
  assert.equal(result.entries['2026-09-29'].habits.focus, true);
  assert.deepEqual(result.entries['2026-09-30'].habits, {});
  assert.equal(result.entries['2026-09-30'].note.length, 10_000);
  assert.deepEqual(validateImport(JSON.stringify(result)), result);
});

test('weekly reviews preserve zero scales and market results while distinguishing unanswered values', () => {
  const state = defaultState();
  state.reviews = {
    '2026-09-23': { win: 'Разговор с клиентом', hard: '', next: 'Подготовить предложение' },
    '2026-09-30': { win: '', hard: '', next: '', satisfaction: 0, autonomy: 10, conversations: 3, offers: 1, paidPilots: 0, output: 'Небольшой оплачиваемый прототип' },
  };
  const result = validateImport(state);
  assert.equal(result.reviews['2026-09-23'].satisfaction, null);
  assert.equal(result.reviews['2026-09-23'].conversations, null);
  assert.equal(result.reviews['2026-09-23'].output, '');
  assert.equal(result.reviews['2026-09-30'].satisfaction, 0);
  assert.equal(result.reviews['2026-09-30'].paidPilots, 0);
  assert.equal(result.reviews['2026-09-30'].conversations, 3);
  assert.deepEqual(validateImport(JSON.stringify(result)), result);
  for (const [field, badValue] of [['satisfaction', 11], ['autonomy', -1], ['conversations', -1], ['offers', 1.5], ['paidPilots', '1'], ['output', false]]) {
    assert.throws(() => validateImport({ version: 1, reviews: { '2026-09-30': { [field]: badValue } } }));
  }
});

test('import rejects prototype pollution, accessors, cycles and exotic objects', () => {
  assert.throws(() => validateImport('{"version":1,"answers":{"__proto__":{"polluted":true}}}'));
  assert.throws(() => validateImport('{"version":1,"answers":{"constructor":"polluted"}}'));
  assert.throws(() => validateImport({ version: 1, profile: new Date() }));
  const cycle = { version: 1 }; cycle.answers = cycle;
  assert.throws(() => validateImport(cycle));
  let getterCalled = false;
  const accessor = { version: 1 };
  Object.defineProperty(accessor, 'answers', { enumerable: true, get() { getterCalled = true; return {}; } });
  assert.throws(() => validateImport(accessor));
  assert.equal(getterCalled, false);
  assert.equal({}.polluted, undefined);
});

test('import rejects unsupported versions, extra fields, invalid types, ranges and calendar dates', () => {
  for (const invalid of [
    { version: 2 }, { version: 1, unexpected: true },
    { version: 1, profile: { income: '100' } }, { version: 1, profile: { income: -1 } },
    { version: 1, profile: { assets: Infinity } }, { version: 1, profile: { goalAmount: 0 } },
    { version: 1, profile: { currency: 'рубли' } }, { version: 1, profile: { goalKind: 'crypto' } },
    { version: 1, profile: { goalDate: '2027-02-29' } },
    { version: 1, entries: { '2026-02-30': { mood: 2 } } },
    { version: 1, entries: { '2026-09-30': { mood: 11 } } },
    { version: 1, entries: { '2026-09-30': { sleep: 25 } } },
    { version: 1, entries: { '2026-09-30': { habits: { focus: 1 } } } },
    { version: 1, entries: { '2026-09-30': { habits: null } } },
    { version: 1, finances: { '2026-13': { income: 100 } } },
    { version: 1, answers: { freeform: ['not', 'text'] } },
    { version: 1, reviews: { '2026-09-30': { win: 5 } } },
    { version: 1, milestones: { first: 'true' } },
    { version: 1, habitPlans: [{ id: 'focus', title: 'Фокус', target: 8 }] },
    { version: 1, habitPlans: [{ id: 'focus', title: 'Фокус' }, { id: 'focus', title: 'Другое' }] },
  ]) assert.throws(() => validateImport(invalid), JSON.stringify(invalid));
});

test('import enforces size limits and refuses sparse arrays', () => {
  assert.throws(() => validateImport({ version: 1, answers: { huge: 'x'.repeat(10_001) } }));
  assert.throws(() => validateImport(' '.repeat(2_000_001)));
  assert.throws(() => validateImport({ version: 1, habitPlans: Array(2) }));
  assert.throws(() => validateImport({ version: 1, habitPlans: Array.from({ length: 21 }, (_, i) => ({ id: `habit${i}`, title: 'Habits' })) }));
});

test('weekly averages include zero, exclude missing values and ignore future/out-of-window data', () => {
  const state = stateAt('2026-09-01');
  state.entries = {
    '2026-09-20': { mood: 10, focusMinutes: 999 },
    '2026-09-29': { mood: 0, energy: null, meaning: 0, focusMinutes: 0 },
    '2026-09-30': { mood: 8, energy: 4, meaning: 6, focusMinutes: 12 },
    '2026-10-01': { mood: 10, energy: 10, focusMinutes: 999 },
  };
  const result = metrics(state, day(2026, 9, 30));
  assert.equal(result.moodAverage, 4);
  assert.equal(result.energyAverage, 4);
  assert.equal(result.meaningAverage, 3);
  assert.equal(result.focusMinutes, 12);
  assert.equal(result.moodCount, 2);
  assert.equal(result.energyCount, 1);
  assert.equal(result.meaningCount, 2);
  assert.equal(result.focusCount, 2);
  assert.equal(result.daysLogged, 3);
  assert.equal(result.loggedThisWeek, 2);
});

test('per-metric observation counts distinguish unanswered check-ins from numeric zero', () => {
  const state = stateAt('2026-09-29');
  state.entries = {
    '2026-09-23': { mood: 8, energy: 7, meaning: 6, focusMinutes: 15 },
    '2026-09-29': { mood: null, energy: null, meaning: 0, focusMinutes: null, note: 'Только заметка' },
    '2026-09-30': { mood: null, energy: 0, meaning: null, focusMinutes: 0 },
  };
  const result = metrics(state, day(2026, 9, 30));
  assert.equal(result.moodCount, 0);
  assert.equal(result.moodAverage, null);
  assert.equal(result.energyCount, 1);
  assert.equal(result.energyAverage, 0);
  assert.equal(result.meaningCount, 1);
  assert.equal(result.meaningAverage, 0);
  assert.equal(result.focusCount, 1);
  assert.equal(result.focusMinutes, 0);
  assert.equal(result.loggedThisWeek, 2);
});

test('backdated diary entries count in weekly observations, independently of habit tracking start', () => {
  const state = stateAt('2026-09-30');
  state.entries = {
    '2026-09-29': { mood: 0, energy: 4, meaning: 6, focusMinutes: 15, habits: { focus: true, move: true } },
    '2026-09-30': { mood: 8, energy: null, meaning: null, focusMinutes: 0, habits: { focus: true } },
  };
  const result = metrics(state, day(2026, 9, 30));
  assert.equal(result.moodAverage, 4);
  assert.equal(result.moodCount, 2);
  assert.equal(result.energyAverage, 4);
  assert.equal(result.meaningAverage, 6);
  assert.equal(result.focusMinutes, 15);
  assert.equal(result.focusCount, 2);
  assert.equal(result.loggedThisWeek, 2);
  assert.equal(result.habitRate, 50);
});

test('habit denominator uses elapsed tracking days and caps each plan independently', () => {
  const state = stateAt('2026-09-29');
  state.habitPlans = [{ id: 'a', target: 4, active: true }, { id: 'b', target: 1, active: true }, { id: 'off', target: 7, active: false }];
  state.entries = { '2026-09-29': { habits: { a: true, b: true } }, '2026-09-30': { habits: { a: false, b: true } } };
  assert.equal(metrics(state, day(2026, 9, 30)).habitRate, 2 / 3 * 100);
  state.entries['2026-09-30'].habits.a = true;
  assert.equal(metrics(state, day(2026, 9, 30)).habitRate, 100);
  state.startedAt = '2026-10-01';
  assert.equal(metrics(state, day(2026, 9, 30)).habitRate, null);
  state.habitPlans = [];
  assert.equal(metrics(state, day(2026, 9, 30)).habitRate, null);
});

test('missed days count toward the target without producing more than 100 percent', () => {
  const state = stateAt('2026-09-01');
  state.habitPlans = [{ id: 'a', target: 4, active: true }];
  state.entries = { '2026-09-30': { habits: { a: true } } };
  assert.equal(metrics(state, day(2026, 9, 30)).habitRate, 25);
  for (const key of currentWeekDates(day(2026, 9, 30))) state.entries[key] = { habits: { a: true } };
  assert.equal(metrics(state, day(2026, 9, 30)).habitRate, 100);
});

test('financial metrics choose latest nonfuture month and preserve zero versus unknown', () => {
  const state = stateAt('2026-09-01');
  state.finances = { '2026-08': completeRecord, '2026-10': { income: 999999, expenses: 0, assets: 999999, debts: 0 } };
  let result = metrics(state, day(2026, 9, 30));
  assert.equal(result.financialMonth, '2026-08');
  assert.equal(result.netWorth, 400);
  assert.equal(result.monthlySurplus, 100);
  assert.equal(result.runway, 0.75);
  assert.equal(result.savingsRate, 100 / 300 * 100);
  state.finances['2026-09'] = { income: 0, expenses: 0, assets: 0, debts: 0 };
  result = metrics(state, day(2026, 9, 30));
  assert.equal(result.netWorth, 0);
  assert.equal(result.monthlySurplus, 0);
  assert.equal(result.savingsRate, null);
  assert.equal(result.runway, null);
  state.finances['2026-09'].debts = null;
  assert.equal(metrics(state, day(2026, 9, 30)).netWorth, null);
});

test('runway never treats illiquid total assets as an emergency fund', () => {
  const state = stateAt('2026-09-01');
  state.finances['2026-09'] = { income: 300, expenses: 200, assets: 100_000, debts: 0 };
  assert.equal(metrics(state, day(2026, 9, 30)).runway, null);
  state.finances['2026-09'].liquidAssets = 0;
  assert.equal(metrics(state, day(2026, 9, 30)).runway, 0);
  state.finances['2026-09'].liquidAssets = 600;
  assert.equal(metrics(state, day(2026, 9, 30)).runway, 3);
});

test('valid financial records can produce negative cash flow and negative net worth', () => {
  const state = defaultState();
  state.finances['2026-09'] = { income: 100, expenses: 200, assets: 10, debts: 300, liquidAssets: 0 };
  const normalized = validateImport(state);
  const result = metrics(normalized, day(2026, 9, 30));
  assert.equal(result.monthlySurplus, -100);
  assert.equal(result.netWorth, -290);
  assert.equal(result.savingsRate, -100);
  assert.equal(result.runway, 0);
});

test('profile financial baseline is used only in the absence of historical records', () => {
  const state = stateAt('2026-09-01');
  assert.equal(metrics(state, day(2026, 9, 30)).financialRecord, null);
  Object.assign(state.profile, completeRecord);
  assert.equal(metrics(state, day(2026, 9, 30)).netWorth, 400);
  assert.equal(metrics(state, day(2026, 9, 30)).financialMonth, null);
  state.finances['2026-09'] = { income: null, expenses: null, assets: null, debts: null };
  assert.equal(metrics(state, day(2026, 9, 30)).netWorth, null);
});

test('capital projection is simple savings arithmetic and crosses month/year boundaries', () => {
  const profile = { goalKind: 'capital', goalAmount: 1000, goalDate: '2027-03-30' };
  const result = projection(profile, completeRecord, day(2026, 9, 30));
  assert.deepEqual(result, { months: 6, netWorth: 400, surplus: 100, gap: 600, requiredMonthly: 100, projected: 1000, possible: true });
  assert.equal(projection({ ...profile, goalDate: '2027-01-01' }, completeRecord, day(2026, 12, 31)).months, 1);
  assert.equal(projection({ ...profile, goalDate: '2026-10-01' }, completeRecord, day(2026, 9, 30)).months, 1);
  assert.equal(projection(profile, { ...completeRecord, debts: null }, day(2026, 9, 30)), null);
  assert.equal(projection(profile, { ...completeRecord, expenses: 400 }, day(2026, 9, 30)).projected, -200);
});

test('past and present goals never divide by zero or claim an unmet goal is feasible', () => {
  const profile = { goalKind: 'capital', goalAmount: 1000, goalDate: '2026-01-01' };
  const result = projection(profile, completeRecord, day(2026, 9, 30));
  assert.equal(result.months, 0);
  assert.equal(result.requiredMonthly, null);
  assert.equal(result.possible, false);
  const achieved = projection({ ...profile, goalAmount: 300 }, completeRecord, day(2026, 9, 30));
  assert.equal(achieved.requiredMonthly, 0);
  assert.equal(achieved.possible, true);
});

test('income goals use income, not capital, and do not invent future income growth', () => {
  const profile = { goalKind: 'monthlyIncome', goalAmount: 1000, goalDate: '2031-09-30' };
  const result = projection(profile, { income: 0, expenses: null, assets: 10_000, debts: 0 }, day(2026, 9, 30));
  assert.equal(result.projected, 0);
  assert.equal(result.gap, 1000);
  assert.equal(result.requiredMonthly, 1000);
  assert.equal(result.possible, false);
  assert.equal(result.surplus, null);
  assert.equal(projection(profile, { income: null }, day(2026, 9, 30)), null);
  assert.equal(projection(profile, { income: 1000 }, day(2026, 9, 30)).possible, true);
});

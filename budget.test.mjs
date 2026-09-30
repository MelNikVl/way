import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHouseholdBudget } from './budget.mjs';

const today = new Date(2026, 8, 30, 12);
const context = () => ({ householdBudget: {
  date: '2026-09-30', currency: 'KZT', salaryKzt: 1000, spouseSalaryKzt: 500,
  rentRub: 100, expensesKzt: 1500, rentalCostsRub: null,
  fx: { date: '2026-09-29', rubPerUsd: 100, rubPer100Kzt: 20, sourceUrl: 'https://example.org/dated-rates' },
} });

test('dated cross-rate converts 100 KZT quote correctly and separates spouse scenarios', () => {
  const result = buildHouseholdBudget(context(), today);
  assert.equal(result.fx.valid, true);
  assert.equal(result.fx.kztPerRub, 5);
  assert.equal(result.fx.kztPerUsd, 500);
  assert.equal(result.rentKzt, 500);
  assert.equal(result.rentUsd, 1);
  assert.deepEqual(result.beforeSpouse, { grossIncomeKzt: 2000, grossIncomeUsd: 4, grossSurplusKzt: 500, grossSurplusUsd: 1 });
  assert.deepEqual(result.afterSpouse, { grossIncomeKzt: 1500, grossIncomeUsd: 3, grossSurplusKzt: 0, grossSurplusUsd: 0 });
  assert.equal(result.rentalCostsRub, null);
  assert.equal(result.rentalCostsKnown, false);
});

test('rental stress cases retain 100, 80 and 60 percent and preserve negative cash flow', () => {
  const scenarios = buildHouseholdBudget(context(), today).scenarios;
  assert.deepEqual(scenarios.map(row => row.haircut), [0, 0.2, 0.4]);
  assert.deepEqual(scenarios.map(row => row.rentRetainedRub), [100, 80, 60]);
  assert.deepEqual(scenarios.map(row => row.rentRetainedKzt), [500, 400, 300]);
  assert.deepEqual(scenarios.map(row => row.beforeSpouse.surplusKzt), [500, 400, 300]);
  assert.deepEqual(scenarios.map(row => row.afterSpouse.surplusKzt), [0, -100, -200]);
  assert.deepEqual(scenarios.map(row => row.afterSpouse.surplusUsd), [0, -0.2, -0.4]);
});

test('unknown inputs never become zero while explicitly entered zeros are retained', () => {
  const source = context();
  source.householdBudget.spouseSalaryKzt = null;
  let result = buildHouseholdBudget(source, today);
  assert.equal(result.beforeSpouse.grossIncomeKzt, null);
  assert.equal(result.afterSpouse.grossIncomeKzt, 1500);
  source.householdBudget.expensesKzt = null;
  result = buildHouseholdBudget(source, today);
  assert.equal(result.afterSpouse.grossIncomeKzt, 1500);
  assert.equal(result.afterSpouse.grossSurplusKzt, null);
  source.householdBudget.expensesKzt = 0;
  source.householdBudget.spouseSalaryKzt = 0;
  source.householdBudget.rentRub = 0;
  source.householdBudget.rentalCostsRub = 0;
  result = buildHouseholdBudget(source, today);
  assert.equal(result.rentalCostsKnown, true);
  assert.equal(result.rentKzt, 0);
  assert.equal(result.beforeSpouse.grossSurplusKzt, 1000);
  source.householdBudget.salaryKzt = '1000';
  assert.equal(buildHouseholdBudget(source, today).afterSpouse.grossIncomeKzt, null);
});

test('missing, unsafe or future FX metadata blocks all currency conversion', () => {
  for (const override of [
    { date: '2026-10-01' }, { date: '2026-02-30' }, { date: '' },
    { sourceUrl: '' }, { sourceUrl: 'javascript:alert(1)' }, { sourceUrl: 'file:///private/context.json' },
    { sourceUrl: 'https://user:password@example.org/rates' }, { rubPerUsd: 0 }, { rubPer100Kzt: -1 },
    { rubPerUsd: Infinity }, { rubPer100Kzt: '20' }, { rubPer100Kzt: 1e-310 },
  ]) {
    const source = context();
    Object.assign(source.householdBudget.fx, override);
    const result = buildHouseholdBudget(source, today);
    assert.equal(result.fx.valid, false, JSON.stringify(override));
    assert.equal(result.rentKzt, null);
    assert.equal(result.afterSpouse.grossIncomeUsd, null);
    assert.equal(result.scenarios[1].rentRetainedKzt, null);
  }
});

test('future budget dates and other currencies cannot masquerade as current KZT totals', () => {
  const source = context();
  source.householdBudget.date = '2026-10-01';
  let result = buildHouseholdBudget(source, today);
  assert.equal(result.budgetDateValid, false);
  assert.equal(result.beforeSpouse.grossIncomeKzt, null);
  source.householdBudget.date = '2026-09-30';
  source.householdBudget.currency = 'USD';
  result = buildHouseholdBudget(source, today);
  assert.equal(result.available, false);
  assert.equal(result.afterSpouse.grossSurplusKzt, null);
  assert.equal(buildHouseholdBudget(null, today).rentRub, null);
  assert.throws(() => buildHouseholdBudget(source, new Date('invalid')), TypeError);
});

test('reported rental costs remain explicit and are not counted twice in stress assumptions', () => {
  const source = context();
  source.householdBudget.rentalCostsRub = 20;
  const result = buildHouseholdBudget(source, today);
  assert.equal(result.rentalCostsKnown, true);
  assert.equal(result.rentalCostsRub, 20);
  assert.equal(result.beforeSpouse.grossSurplusKzt, 500);
  assert.equal(result.scenarios[1].beforeSpouse.surplusKzt, 400);
});

test('budget calculation is pure and returns independent objects', () => {
  const source = context();
  const before = structuredClone(source);
  const first = buildHouseholdBudget(source, today);
  first.scenarios[0].afterSpouse.surplusKzt = 999;
  first.fx.sourceUrl = 'changed';
  assert.deepEqual(source, before);
  const second = buildHouseholdBudget(source, today);
  assert.equal(second.scenarios[0].afterSpouse.surplusKzt, 0);
  assert.equal(second.fx.sourceUrl, 'https://example.org/dated-rates');
});

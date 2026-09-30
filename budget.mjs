/** Household cash-flow scenarios. Inputs are facts supplied by the user;
 * rental haircuts are stress assumptions, not expected costs or forecasts. */
const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e15;
const amount = value => known(value) ? value : null;
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const add = (...values) => values.every(value => value !== null) ? finite(values.reduce((sum, value) => sum + value, 0)) : null;
const subtract = (a, b) => a !== null && b !== null ? a - b : null;

function localDay(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('Некорректная дата расчёта бюджета.');
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function validDate(value, today) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && value <= today ? value : null;
}

function validSource(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

export function buildHouseholdBudget(context, today = new Date()) {
  const todayKey = localDay(today);
  const candidate = context?.householdBudget;
  const source = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? candidate : null;
  const available = !!source && source.currency === 'KZT';
  const budgetDate = validDate(source?.date, todayKey);
  const budgetDateValid = budgetDate !== null;
  const usable = available && budgetDateValid;
  const salaryKzt = amount(source?.salaryKzt);
  const spouseSalaryKzt = amount(source?.spouseSalaryKzt);
  const rentRub = amount(source?.rentRub);
  const expensesKzt = amount(source?.expensesKzt);
  const rentalCostsRub = amount(source?.rentalCostsRub);
  const fxDate = validDate(source?.fx?.date, todayKey);
  const sourceUrl = validSource(source?.fx?.sourceUrl);
  const rubPerUsd = amount(source?.fx?.rubPerUsd);
  const rubPer100Kzt = amount(source?.fx?.rubPer100Kzt);
  const fxEligible = usable && fxDate !== null && sourceUrl !== null && rubPerUsd !== null && rubPerUsd > 0 && rubPer100Kzt !== null && rubPer100Kzt > 0;
  const candidateKztPerRub = fxEligible ? finite(100 / rubPer100Kzt) : null;
  const candidateKztPerUsd = candidateKztPerRub === null ? null : finite(rubPerUsd * candidateKztPerRub);
  const fxValid = fxEligible && candidateKztPerRub !== null && candidateKztPerRub > 0 && candidateKztPerUsd !== null && candidateKztPerUsd > 0;
  const kztPerRub = fxValid ? candidateKztPerRub : null;
  const kztPerUsd = fxValid ? candidateKztPerUsd : null;
  const convertRub = value => value !== null && fxValid ? finite(value * kztPerRub) : null;
  const convertKzt = value => value !== null && fxValid ? finite(value / kztPerUsd) : null;
  const rentKzt = convertRub(rentRub);
  const rentUsd = convertKzt(rentKzt);

  function household(rentalKzt, includeSpouse) {
    const incomeKzt = usable ? add(salaryKzt, includeSpouse ? spouseSalaryKzt : 0, rentalKzt) : null;
    const surplusKzt = subtract(incomeKzt, usable ? expensesKzt : null);
    return { incomeKzt, incomeUsd: convertKzt(incomeKzt), surplusKzt, surplusUsd: convertKzt(surplusKzt) };
  }
  const gross = values => ({ grossIncomeKzt: values.incomeKzt, grossIncomeUsd: values.incomeUsd, grossSurplusKzt: values.surplusKzt, grossSurplusUsd: values.surplusUsd });
  const scenarios = [0, 0.2, 0.4].map(haircut => {
    const retainedRate = 1 - haircut;
    const rentRetainedRub = rentRub === null ? null : rentRub * retainedRate;
    const rentRetainedKzt = convertRub(rentRetainedRub);
    return {
      name: haircut === 0 ? 'Аренда без удержаний' : `Из аренды удержано ${Math.round(haircut * 100)}%`,
      haircut, retainedRate, rentRetainedRub, rentRetainedKzt,
      rentRetainedUsd: convertKzt(rentRetainedKzt),
      beforeSpouse: household(rentRetainedKzt, true),
      afterSpouse: household(rentRetainedKzt, false),
    };
  });
  const assumptions = [
    'Сценарий до ухода супруги включает обе указанные зарплаты; после ухода её зарплата равна нулю только в расчётном сценарии. Исходные данные не изменяются.',
    'Валовой остаток включает всю указанную аренду до неучтённых налогов, расходов и простоя. Его нельзя автоматически считать доступными сбережениями.',
    'Удержания 0%, 20% и 40% — условные стресс-сценарии совокупных потерь и расходов по аренде. Это не прогноз и не оценка фактических налогов; заявленные расходы не вычитаются повторно.',
    'Курс применяется только при положительных значениях, существующей дате не позднее сегодняшней и указанной веб-ссылке на источник. Новые курсы автоматически не загружаются.',
    'Бонусы, рост зарплаты и прочие неуказанные поступления в сценарии не включены. Неизвестная сумма не превращается в ноль.',
  ];
  if (rentalCostsRub === null) assumptions.push('Фактические расходы и налоги по аренде неизвестны; чистый арендный доход не установлен.');
  if (!budgetDateValid) assumptions.push('Дата исходного бюджета отсутствует, некорректна или находится в будущем; итоговые суммы не рассчитаны.');
  if (!fxValid) assumptions.push('Для пересчёта аренды недостаточно корректных исходных данных или датированного курса с источником.');
  if (!available) assumptions.push('Ожидается семейный бюджет с валютой KZT; другие валюты не переименовываются автоматически.');

  return {
    available, budgetDate, budgetDateValid, currency: 'KZT',
    salaryKzt, spouseSalaryKzt, rentRub, expensesKzt, rentalCostsRub,
    rentalCostsKnown: rentalCostsRub !== null,
    fx: { valid: fxValid, date: fxDate, sourceUrl, kztPerRub, kztPerUsd, rubPerUsd, rubPer100Kzt },
    rentKzt, rentUsd,
    beforeSpouse: gross(household(rentKzt, true)), afterSpouse: gross(household(rentKzt, false)),
    scenarios, assumptions,
  };
}

/** Pure, local-only calculations for «Путь маленьких шагов». */
export const STORAGE_KEY = 'small-steps-v1';

const FINANCIAL_FIELDS = ['income', 'expenses', 'assets', 'debts', 'liquidAssets'];
const ENTRY_NUMBERS = ['mood', 'energy', 'sleep', 'meaning', 'focusMinutes'];
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const MAX_MONEY = 1e15;
const MAX_IMPORT_CHARS = 2_000_000;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const knownNumber = value => typeof value === 'number' && Number.isFinite(value);

export function dateKey(date = new Date()) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('Некорректная дата.');
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localDate(key) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(12, 0, 0, 0);
  return date;
}

function fiveYearsFrom(date) {
  const result = new Date(date);
  const month = result.getMonth();
  result.setFullYear(result.getFullYear() + 5);
  if (result.getMonth() !== month) result.setDate(0);
  return dateKey(result);
}

export function defaultState() {
  const today = new Date();
  return {
    version: 1,
    startedAt: dateKey(today),
    profile: {
      name: '', currency: 'KZT', goalAmount: 1_000_000, goalKind: 'capital', goalScope: 'personal',
      goalDate: fiveYearsFrom(today), dailyMinutes: 15,
      income: null, expenses: null, assets: null, debts: null, liquidAssets: null,
    },
    answers: {}, entries: {},
    habitPlans: [
      { id: 'focus', title: '10 минут на ценный навык', cue: 'После первого утреннего напитка', minimum: 'Открыть материал и заниматься 2 минуты', target: 4, active: true },
      { id: 'move', title: '10 минут движения', cue: 'После обеда', minimum: 'Выйти на 2 минуты', target: 4, active: true },
    ],
    finances: {}, reviews: {}, milestones: {},
  };
}

function invalid(path, reason) {
  throw new Error(`Невозможно импортировать: ${path} — ${reason}.`);
}

function objectAt(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(path, 'ожидался объект');
  return value;
}

function exactKeys(value, keys, path) {
  objectAt(value, path);
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`${path}.${key}`, 'неизвестное поле');
}

function stringAt(value, path, max = 6000, allowEmpty = true) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) invalid(path, `ожидался текст длиной ${allowEmpty ? 'от 0' : 'от 1'} до ${max} символов`);
  return value;
}

function numberAt(value, path, min, max, nullable = true, integer = false) {
  if (value === null && nullable) return null;
  if (!knownNumber(value) || value < min || value > max || (integer && !Number.isInteger(value))) invalid(path, `ожидалось ${nullable ? 'число или null' : 'число'} от ${min} до ${max}`);
  return value;
}

function booleanAt(value, path) {
  if (typeof value !== 'boolean') invalid(path, 'ожидалось true или false');
  return value;
}

function idAt(value, path) {
  stringAt(value, path, 80, false);
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(value) || UNSAFE_KEYS.has(value)) invalid(path, 'некорректный идентификатор');
  return value;
}

function dateAt(value, path) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || dateKey(localDate(value)) !== value) invalid(path, 'ожидалась существующая дата ГГГГ-ММ-ДД');
  return value;
}

function monthAt(value, path) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) invalid(path, 'ожидался месяц ГГГГ-ММ');
  return value;
}

function dictionary(value, path, limit, keyCheck, itemCheck) {
  objectAt(value, path);
  const entries = Object.entries(value);
  if (entries.length > limit) invalid(path, `слишком много записей (максимум ${limit})`);
  return Object.fromEntries(entries.map(([key, item]) => {
    keyCheck(key, `${path}.${key}`);
    return [key, itemCheck(item, `${path}.${key}`)];
  }));
}

// Inspect descriptors before reading values: even programmatic imports cannot
// smuggle getters, exotic prototypes, cycles, or prototype-polluting keys.
function validateJSONTree(value) {
  let chars = 0;
  let nodes = 0;
  const ancestors = new Set();
  const inspect = (item, path, depth) => {
    if (++nodes > 150_000 || depth > 8) invalid(path, 'слишком сложная структура');
    if (typeof item === 'string') {
      chars += item.length;
      if (chars > MAX_IMPORT_CHARS) invalid(path, 'файл слишком большой');
      return;
    }
    if (item === null || typeof item === 'boolean' || knownNumber(item)) return;
    if (typeof item !== 'object') invalid(path, 'допустимы только значения JSON');
    const prototype = Object.getPrototypeOf(item);
    if (Array.isArray(item) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid(path, 'некорректный тип объекта');
    if (ancestors.has(item)) invalid(path, 'циклическая структура');
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Object.getOwnPropertySymbols(item).length) invalid(path, 'символьные поля не поддерживаются');
    let arrayItems = 0;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (UNSAFE_KEYS.has(key)) invalid(`${path}.${key}`, 'небезопасное имя поля');
      if (!own(descriptor, 'value') || !descriptor.enumerable) invalid(`${path}.${key}`, 'допустимы только обычные поля JSON');
      if (Array.isArray(item)) {
        if (!/^(0|[1-9]\d*)$/.test(key)) invalid(`${path}.${key}`, 'неверное поле массива');
        arrayItems++;
      }
      chars += key.length;
      inspect(descriptor.value, `${path}.${key}`, depth + 1);
    }
    if (Array.isArray(item) && item.length !== arrayItems) invalid(path, 'массив не должен содержать пропуски');
    if (chars > MAX_IMPORT_CHARS) invalid(path, 'файл слишком большой');
    ancestors.delete(item);
  };
  inspect(value, 'данные', 0);
}

function financialRecordAt(value, path) {
  exactKeys(value, FINANCIAL_FIELDS, path);
  return Object.fromEntries(FINANCIAL_FIELDS.map(key => [key, numberAt(own(value, key) ? value[key] : null, `${path}.${key}`, 0, MAX_MONEY)]));
}

function entryAt(value, path) {
  exactKeys(value, [...ENTRY_NUMBERS, 'note', 'habits'], path);
  const result = {};
  for (const key of ENTRY_NUMBERS) {
    const max = key === 'sleep' ? 24 : key === 'focusMinutes' ? 1440 : 10;
    result[key] = numberAt(own(value, key) ? value[key] : null, `${path}.${key}`, 0, max);
  }
  result.note = stringAt(own(value, 'note') ? value.note : '', `${path}.note`, 10_000);
  result.habits = dictionary(own(value, 'habits') ? value.habits : {}, `${path}.habits`, 100, idAt, booleanAt);
  return result;
}

/** Validate untrusted backup data and return a detached, normalized state. */
export function validateImport(input) {
  let source = input;
  if (typeof input === 'string') {
    if (input.length > MAX_IMPORT_CHARS) invalid('файл', 'максимальный размер 2 МБ');
    try { source = JSON.parse(input); } catch { invalid('файл', 'некорректный JSON'); }
  }
  validateJSONTree(source);
  const fallback = defaultState();
  exactKeys(source, Object.keys(fallback), 'данные');
  if (source.version !== 1) invalid('version', 'эта версия резервной копии не поддерживается');
  const result = defaultState();
  if (own(source, 'startedAt')) result.startedAt = dateAt(source.startedAt, 'startedAt');

  if (own(source, 'profile')) {
    const profile = source.profile;
    exactKeys(profile, Object.keys(fallback.profile), 'profile');
    if (own(profile, 'name')) result.profile.name = stringAt(profile.name, 'profile.name', 160);
    if (own(profile, 'currency')) {
      if (typeof profile.currency !== 'string' || !/^[A-Z]{3}$/.test(profile.currency)) invalid('profile.currency', 'ожидался трёхбуквенный код валюты');
      result.profile.currency = profile.currency;
    }
    if (own(profile, 'goalKind')) {
      if (!['capital', 'monthlyIncome'].includes(profile.goalKind)) invalid('profile.goalKind', 'неизвестный тип цели');
      result.profile.goalKind = profile.goalKind;
    }
    if (own(profile, 'goalScope')) {
      if (!['family', 'personal'].includes(profile.goalScope)) invalid('profile.goalScope', 'ожидался личный или семейный охват цели');
      result.profile.goalScope = profile.goalScope;
    }
    if (own(profile, 'goalAmount')) result.profile.goalAmount = numberAt(profile.goalAmount, 'profile.goalAmount', 0.01, MAX_MONEY, false);
    if (own(profile, 'goalDate')) result.profile.goalDate = dateAt(profile.goalDate, 'profile.goalDate');
    if (own(profile, 'dailyMinutes')) result.profile.dailyMinutes = numberAt(profile.dailyMinutes, 'profile.dailyMinutes', 1, 1440, false, true);
    for (const key of FINANCIAL_FIELDS) if (own(profile, key)) result.profile[key] = numberAt(profile[key], `profile.${key}`, 0, MAX_MONEY);
  }

  if (own(source, 'answers')) result.answers = dictionary(source.answers, 'answers', 250, idAt, (value, path) => stringAt(value, path, 10_000));
  if (own(source, 'entries')) result.entries = dictionary(source.entries, 'entries', 10_000, dateAt, entryAt);
  if (own(source, 'finances')) result.finances = dictionary(source.finances, 'finances', 1200, monthAt, financialRecordAt);
  if (own(source, 'reviews')) result.reviews = dictionary(source.reviews, 'reviews', 2000, dateAt, (value, path) => {
    const textFields = ['win', 'hard', 'next', 'output'];
    const scoreFields = ['satisfaction', 'autonomy'];
    const countFields = ['conversations', 'offers', 'paidPilots'];
    exactKeys(value, [...textFields, ...scoreFields, ...countFields], path);
    return {
      ...Object.fromEntries(textFields.map(key => [key, stringAt(own(value, key) ? value[key] : '', `${path}.${key}`, 10_000)])),
      ...Object.fromEntries(scoreFields.map(key => [key, numberAt(own(value, key) ? value[key] : null, `${path}.${key}`, 0, 10)])),
      ...Object.fromEntries(countFields.map(key => [key, numberAt(own(value, key) ? value[key] : null, `${path}.${key}`, 0, 1_000_000, true, true)])),
    };
  });
  if (own(source, 'milestones')) result.milestones = dictionary(source.milestones, 'milestones', 500, idAt, booleanAt);
  if (own(source, 'habitPlans')) {
    if (!Array.isArray(source.habitPlans) || source.habitPlans.length > 20) invalid('habitPlans', 'ожидался массив максимум из 20 привычек');
    const ids = new Set();
    result.habitPlans = source.habitPlans.map((plan, index) => {
      const path = `habitPlans.${index}`;
      exactKeys(plan, ['id', 'title', 'cue', 'minimum', 'target', 'active'], path);
      const id = idAt(plan.id, `${path}.id`);
      if (ids.has(id)) invalid(`${path}.id`, 'идентификаторы привычек должны быть уникальны');
      ids.add(id);
      return {
        id,
        title: stringAt(plan.title, `${path}.title`, 300, false),
        cue: stringAt(own(plan, 'cue') ? plan.cue : '', `${path}.cue`, 1000),
        minimum: stringAt(own(plan, 'minimum') ? plan.minimum : '', `${path}.minimum`, 1000),
        target: numberAt(own(plan, 'target') ? plan.target : 4, `${path}.target`, 1, 7, false, true),
        active: booleanAt(own(plan, 'active') ? plan.active : true, `${path}.active`),
      };
    });
  }
  return result;
}

/** The seven local dates ending today, ordered oldest first. */
export function currentWeekDates(date = new Date()) {
  const end = localDate(dateKey(date));
  return Array.from({ length: 7 }, (_, index) => {
    const current = new Date(end);
    current.setDate(current.getDate() - 6 + index);
    return dateKey(current);
  });
}

function isLogged(entry) {
  return !!entry && (ENTRY_NUMBERS.some(key => knownNumber(entry[key])) || !!entry.note?.trim() || Object.values(entry.habits ?? {}).some(value => value === true));
}

function average(entries, field) {
  const numbers = entries.map(entry => entry[field]).filter(knownNumber);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

function financialNumbers(record) {
  const netWorth = record && knownNumber(record.assets) && knownNumber(record.debts) ? record.assets - record.debts : null;
  const monthlySurplus = record && knownNumber(record.income) && knownNumber(record.expenses) ? record.income - record.expenses : null;
  return {
    netWorth, monthlySurplus,
    savingsRate: monthlySurplus !== null && record.income > 0 ? monthlySurplus / record.income * 100 : null,
    runway: record && knownNumber(record.liquidAssets) && knownNumber(record.expenses) && record.expenses > 0 ? record.liquidAssets / record.expenses : null,
  };
}

export function metrics(state, date = new Date()) {
  const today = dateKey(date);
  const weekDates = currentWeekDates(date);
  const elapsedDates = weekDates.filter(key => key >= state.startedAt);
  const weekEntries = weekDates.map(key => state.entries[key]).filter(Boolean);
  const habitEntries = elapsedDates.map(key => state.entries[key]).filter(Boolean);
  const plans = state.habitPlans.filter(plan => plan.active);
  const possible = plans.reduce((sum, plan) => sum + Math.min(plan.target, elapsedDates.length), 0);
  const completed = plans.reduce((sum, plan) => sum + Math.min(plan.target, elapsedDates.length, habitEntries.filter(entry => entry.habits?.[plan.id] === true).length), 0);
  const currentMonth = today.slice(0, 7);
  const financialMonth = Object.keys(state.finances).filter(month => month <= currentMonth).sort().at(-1) ?? null;
  const baseline = Object.fromEntries(FINANCIAL_FIELDS.map(key => [key, state.profile[key] ?? null]));
  const financialRecord = financialMonth ? { ...state.finances[financialMonth] } : FINANCIAL_FIELDS.some(key => knownNumber(baseline[key])) ? baseline : null;
  return {
    daysLogged: Object.entries(state.entries).filter(([key, entry]) => key <= today && isLogged(entry)).length,
    habitRate: possible ? completed / possible * 100 : null,
    moodAverage: average(weekEntries, 'mood'),
    energyAverage: average(weekEntries, 'energy'),
    meaningAverage: average(weekEntries, 'meaning'),
    moodCount: weekEntries.filter(entry => knownNumber(entry.mood)).length,
    energyCount: weekEntries.filter(entry => knownNumber(entry.energy)).length,
    meaningCount: weekEntries.filter(entry => knownNumber(entry.meaning)).length,
    focusCount: weekEntries.filter(entry => knownNumber(entry.focusMinutes)).length,
    focusMinutes: weekEntries.reduce((sum, entry) => sum + (knownNumber(entry.focusMinutes) ? entry.focusMinutes : 0), 0),
    weekDates,
    loggedThisWeek: weekEntries.filter(isLogged).length,
    ...financialNumbers(financialRecord),
    financialRecord, financialMonth,
  };
}

function monthsUntil(goalKey, today) {
  const currentKey = dateKey(today);
  if (goalKey <= currentKey) return 0;
  const target = localDate(goalKey);
  const monthDifference = (target.getFullYear() - today.getFullYear()) * 12 + target.getMonth() - today.getMonth();
  return Math.max(1, monthDifference + (target.getDate() > today.getDate() ? 1 : 0));
}

/** Arithmetic scenario only: no returns, inflation, or assumed income growth. */
export function projection(profile, record, today = new Date()) {
  if (!record || !knownNumber(profile.goalAmount) || profile.goalAmount <= 0) return null;
  try { dateAt(profile.goalDate, 'goalDate'); } catch { return null; }
  const months = monthsUntil(profile.goalDate, today);
  const { netWorth, monthlySurplus: surplus } = financialNumbers(record);
  if (profile.goalKind === 'monthlyIncome') {
    if (!knownNumber(record.income)) return null;
    return { months, netWorth, surplus, gap: Math.max(0, profile.goalAmount - record.income), requiredMonthly: profile.goalAmount, projected: record.income, possible: record.income >= profile.goalAmount };
  }
  if (profile.goalKind !== 'capital' || netWorth === null || surplus === null) return null;
  const gap = Math.max(0, profile.goalAmount - netWorth);
  const projected = netWorth + surplus * months;
  return { months, netWorth, surplus, gap, requiredMonthly: gap === 0 ? 0 : months > 0 ? gap / months : null, projected, possible: projected >= profile.goalAmount };
}

/** Pure planning model. Personal facts enter through state/private context only.
 * The staged capital curve is an editable planning assumption, not evidence of
 * achievable income growth, asset returns, or future sales.
 */
const DAY = 86_400_000;
const SHARES = [0.05, 0.15, 0.35, 0.65, 1];
const known = value => typeof value === 'number' && Number.isFinite(value);
const moneyValue = value => known(value) && value >= 0 ? value : null;
const text = value => typeof value === 'string' ? value.trim() : '';
const round = value => known(value) ? Math.round((value + Number.EPSILON) * 100) / 100 : null;

/** Reviewed guidance is display data, never an automatic edit to answers or observations. */
function sanitizeCoaching(input) {
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(input)) return null;
  const plain = (value, limit = 2000) => text(value).slice(0, limit);
  const id = value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value)
    && !['constructor', 'prototype', '__proto__'].includes(value) ? value : null;
  const strings = (value, limit = 8) => Array.isArray(value)
    ? value.slice(0, 100).filter(item => typeof item === 'string').map(item => plain(item)).filter(Boolean).slice(0, limit) : [];
  const rows = (value, limit, convert, identity = item => item.id) => {
    if (!Array.isArray(value)) return [];
    const result = [], seen = new Set();
    for (const raw of value.slice(0, 100)) {
      if (!record(raw)) continue;
      const item = convert(raw);
      if (!item || seen.has(identity(item))) continue;
      seen.add(identity(item)); result.push(item);
      if (result.length === limit) break;
    }
    return result;
  };
  const income = value => record(value) && known(value.amount) && value.amount >= 0 && value.amount <= 1e15
    && ['USD', 'RUB', 'KZT'].includes(value.currency) && ['personal', 'family'].includes(value.scope)
    && value.period === 'month' && value.basis === 'net'
    ? { amount: value.amount, currency: value.currency, scope: value.scope, period: 'month', basis: 'net' } : null;
  return {
    reviewedAt: validKey(input.reviewedAt), summary: plain(input.summary),
    incomeCheckpoints: rows(input.incomeCheckpoints, 5, item => {
      const key = id(item.id), due = validKey(item.due), title = plain(item.title, 300);
      if (!key || !due || !title || !['week', 'month', 'halfyear', 'year', 'fiveyears'].includes(item.horizon)) return null;
      return { id: key, horizon: item.horizon, due, title, targetIncome: income(item.targetIncome),
        criteria: strings(item.criteria), action: plain(item.action) };
    }),
    weeklyRhythm: rows(input.weeklyRhythm, 7, item => {
      const title = plain(item.title, 300), action = plain(item.action);
      if (!Number.isInteger(item.day) || item.day < 1 || item.day > 7 || !title || !action
        || !known(item.minutes) || item.minutes < 0 || item.minutes > 1440) return null;
      return { day: item.day, title, minutes: item.minutes, action, minimum: plain(item.minimum), output: plain(item.output) };
    }, item => item.day),
    habitPrescriptions: rows(input.habitPrescriptions, 2, item => {
      const key = id(item.id), title = plain(item.title, 300), cue = plain(item.cue, 1000), minimum = plain(item.minimum, 1000);
      if (!key || !title || !cue || !minimum || !Number.isInteger(item.target) || item.target < 1 || item.target > 7) return null;
      return { id: key, title, cue, minimum, target: item.target, why: plain(item.why) };
    }),
    metrics: rows(input.metrics, 8, item => {
      const key = id(item.id), label = plain(item.label, 300), measurement = plain(item.measurement), frequency = plain(item.frequency, 300);
      if (!key || !label || !measurement || !frequency) return null;
      return { id: key, label, baseline: plain(item.baseline), target: plain(item.target), measurement, frequency };
    }),
    reviewRules: strings(input.reviewRules), safeguards: strings(input.safeguards),
  };
}

function dayKey(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('Некорректная дата расчёта.');
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function serial(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date.getTime() / DAY : null;
}
function keyFromSerial(value) { return new Date(value * DAY).toISOString().slice(0, 10); }
function validKey(value) { return serial(value) === null ? null : value; }
function addMonths(key, months) {
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1 + months, 1);
  date.setUTCHours(0, 0, 0, 0);
  const end = new Date(date);
  end.setUTCMonth(end.getUTCMonth() + 1, 0);
  date.setUTCDate(Math.min(d, end.getUTCDate()));
  return date.toISOString().slice(0, 10);
}
/** Calendar months plus a fraction of the next anchored month; no DST effects. */
function monthsBetween(start, end) {
  if (serial(start) === null || serial(end) === null) return null;
  if (end <= start) return 0;
  const a = start.split('-').map(Number), b = end.split('-').map(Number);
  let whole = (b[0] - a[0]) * 12 + b[1] - a[1];
  if (addMonths(start, whole) > end) whole--;
  const anchor = serial(addMonths(start, whole)), next = serial(addMonths(start, whole + 1));
  return whole + (serial(end) - anchor) / (next - anchor);
}
function dateAtMonths(start, months) {
  const whole = Math.floor(months + 1e-10), fraction = Math.max(0, months - whole);
  const anchor = serial(addMonths(start, whole)), next = serial(addMonths(start, whole + 1));
  return keyFromSerial(anchor + Math.round((next - anchor) * fraction));
}
function numericAnswer(value, allowNegative = false) {
  const source = text(value).replace(',', '.');
  if (!source || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(source)) return null;
  const number = Number(source);
  return Number.isFinite(number) && Math.abs(number) <= 1e15 && (allowNegative || number >= 0) ? number : null;
}

/** Separate personal net-income observations; never infer them from household finances. */
export function personalIncomeProgress(state = {}, currency = 'USD', today = new Date()) {
  if (!['USD', 'KZT', 'RUB'].includes(currency)) throw new TypeError('Неподдерживаемая валюта личного дохода.');
  const currentMonth = dayKey(today).slice(0, 7);
  const periodMonths = [3, 2, 1].map(offset => addMonths(`${currentMonth}-01`, -offset).slice(0, 7));
  const prefix = `personalIncome_${currency}_`;
  const records = [];
  for (const [key, value] of Object.entries(state?.answers || {})) {
    if (!key.startsWith(prefix)) continue;
    const month = key.slice(prefix.length);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > currentMonth) continue;
    const amount = numericAnswer(value);
    if (amount !== null && amount <= 1e12) records.push({ month, amount });
  }
  records.sort((a, b) => b.month.localeCompare(a.month));
  const byMonth = new Map(records.map(item => [item.month, item.amount]));
  const observations = periodMonths.filter(month => byMonth.has(month));
  return {
    currency, latestMonth: records[0]?.month ?? null, latestAmount: records[0]?.amount ?? null,
    periodMonths, observationCount: observations.length,
    threeMonthAverage: observations.length === 3 ? round(periodMonths.reduce((sum, month) => sum + byMonth.get(month), 0) / 3) : null,
    records,
  };
}

function selectedRecord(state, now) {
  const month = Object.keys(state.finances || {}).filter(key => /^\d{4}-(0[1-9]|1[0-2])$/.test(key) && key <= now.slice(0, 7)).sort().at(-1) || null;
  return { record: month ? state.finances[month] : (state.profile || {}), month };
}
function chosenFx(answers, context, now) {
  const hasOverride = !!(text(answers.planFxRate) || text(answers.planFxDate));
  const rate = hasOverride ? numericAnswer(answers.planFxRate) : moneyValue(context?.valuation?.fxRate);
  const date = validKey(hasOverride ? text(answers.planFxDate) : context?.valuation?.fxDate);
  const valid = rate !== null && rate > 0 && date !== null && date <= now;
  return {
    rate: valid ? rate : null, date: valid ? date : null,
    source: valid ? (hasOverride ? 'user-fx' : 'reference-fx') : 'needs-valuation',
    sourceUrl: valid && !hasOverride ? text(context?.valuation?.sourceUrl) || null : null,
    incompleteOverride: hasOverride && !valid,
  };
}

function baseline(state, context, now, eligible, fx) {
  const profile = state.profile || {}, answers = state.answers || {};
  const explicitCapital = text(answers.planStartingCapital);
  const explicitStart = text(answers.planStartDate);
  const chosenStart = validKey(explicitStart || context?.valuation?.planStartDate || state.startedAt);
  const start = chosenStart && chosenStart <= now ? chosenStart : null;
  if (!eligible) return { value: null, start, source: 'unsupported-goal' };
  if (explicitCapital) {
    const value = numericAnswer(explicitCapital, true);
    const date = validKey(explicitStart);
    return { value: date && date <= now ? value : null, start: date && date <= now ? date : start, source: value !== null && date && date <= now ? 'explicit-usd' : 'needs-valuation' };
  }
  // Fixed profile baseline takes precedence over the private RUB asset draft.
  // Monthly finance entries never rewrite this baseline.
  if (moneyValue(profile.assets) !== null) {
    const profileStart = validKey(explicitStart || state.startedAt);
    const datedStart = profileStart && profileStart <= now ? profileStart : null;
    return { value: datedStart && moneyValue(profile.debts) !== null ? profile.assets - profile.debts : null, start: datedStart, source: 'profile-usd' };
  }
  const draft = context?.assetDraft;
  const draftScope = context?.seedProfile?.goalScope;
  const matchingScope = draftScope && draftScope === profile.goalScope;
  const items = Array.isArray(draft?.items) && draft.items.length ? draft.items : null;
  const allKnown = items && items.every(item => moneyValue(item?.amount) !== null);
  const total = allKnown ? items.reduce((sum, item) => sum + item.amount, 0) : null;
  if (!start || !matchingScope || draft?.currency !== 'RUB' || !known(total) || total > 1e15 || fx.rate === null || moneyValue(profile.debts) === null) {
    return { value: null, start, source: 'needs-valuation' };
  }
  return { value: total / fx.rate - profile.debts, start, source: fx.source };
}

const DIRECTIONS = {
  service: {
    label: 'Небольшая техническая услуга',
    reason: 'Рабочая гипотеза: проверить знакомую техническую задачу — например, автоматизацию повторяющейся работы — через разговоры и небольшой оплачиваемый пилот. Параллельный короткий карьерный тест даст альтернативу. Это позволяет получить внешние данные до длительной разработки продукта; спрос и оплата пока не подтверждены.',
    nextStep: 'За один короткий блок описать одну повторяющуюся задачу, кому мешает проблема и какой результат можно показать за неделю.',
    pivotEvidence: ['После 5 содержательных разговоров проблема не повторяется — поменять задачу или группу клиентов.', 'После 3 конкретных предложений нет готовности оплачивать пилот — выяснить причину, пересмотреть пользу, цену или направление; это сигнал для проверки, не доказательство отсутствия рынка.', 'После пилота затраты времени и денег не оставляют приемлемого чистого дохода — изменить объём услуги или сравнить с карьерной альтернативой.'],
    stages: [
      ['Выбрать одну услугу и проверить задачу', ['Описаны один покупатель, его задача и проверяемый результат услуги.', 'Составлен список 5 подходящих собеседников; получена первая внешняя обратная связь.', 'Выбраны 2 подходящие карьерные возможности для сравнения условий.'], 'Подготовить короткое предложение: задача → результат → границы работы → цена как гипотеза.'],
      ['Дойти до первого платного подтверждения', ['Проведено 5 разговоров о реальной задаче и отправлено 3 конкретных предложения.', 'Цель — 1 оплаченный пилот; если оплаты нет, записать причины и выбрать следующий тест.', 'До пилота определены результат, срок, стоимость и предел расходов.'], 'Предложить минимальный оплачиваемый объём работы и зафиксировать результат проверки.'],
      ['Проверить повторяемость чистого дохода', ['Есть не менее 2 оплаченных выполнений сходной услуги либо принято обоснованное решение сменить направление.', 'За 3 месяца записаны поступления, расходы на выполнение и потраченное время.', 'Выбран один канал привлечения с измеримыми результатами.'], 'Повторить подтвердившее спрос предложение и убрать работу без полезного результата.'],
      ['Сделать доход устойчивее без перегрузки', ['Сравнены чистый доход за последние 3 месяца, рабочие часы и исходный уровень.', 'Документированы 3 результата для клиентов или работодателя.', 'Решено, что стандартизировать, делегировать или прекратить на основании фактической маржи.'], 'Обновить цену и границы предложения по подтверждённым результатам, проверить план следующего года.'],
    ],
  },
  career: {
    label: 'Карьерный рост',
    reason: 'Выбран карьерный путь. Короткий тест вакансий, требований и разговоров с работодателями покажет ценность опыта и дефицит навыков до длительного обучения. Роль и возможное повышение считаются гипотезой, пока нет внешней обратной связи или предложения.',
    nextStep: 'Выбрать 3 интересные вакансии и выписать повторяющиеся задачи, требования и условия оплаты.',
    pivotEvidence: ['После 8 подходящих откликов нет содержательной обратной связи — проверить соответствие роли, резюме и способ выхода на работодателя.', 'После 3 профессиональных разговоров повторяется один дефицит навыка — закрыть его небольшим демонстрируемым проектом.', 'Условия предложений не дают достаточного чистого прироста с учётом нагрузки — сравнить другую роль, рынок или услугу.'],
    stages: [
      ['Выбрать роль и показать сильный результат', ['Изучены 5 подходящих вакансий; текущая роль и навыки подтверждены самим пользователем.', 'Описан 1 завершённый рабочий результат с измеримой пользой.', 'Назначен первый профессиональный разговор.'], 'Собрать короткий кейс: исходная задача, ваше действие и подтверждённый результат.'],
      ['Проверить карьерное предложение рынком', ['Отправлено 8 адресных откликов или выходов на профессиональные контакты.', 'Получены 3 содержательных разговора либо записаны препятствия и новый тест.', 'Есть сравнение условий оплаты, времени и требований.'], 'Доработать резюме и кейс по повторяющейся внешней обратной связи.'],
      ['Получить измеримый карьерный результат', ['Цель — подтверждённый оффер, повышение или новые оплачиваемые обязанности; если результата нет, пересмотреть гипотезу.', 'Сравнены доход после налогов и расходы, связанные с новой работой.', 'Выбран 1 востребованный навык и завершён подтверждающий его проект.'], 'Обсудить конкретный следующий уровень ответственности и оплату на основе результатов.'],
      ['Закрепить рыночную ценность и выбор', ['Собраны 3 подтверждённых кейса и внешняя обратная связь.', 'Есть данные об альтернативных ролях и условиях, а не только текущей работе.', 'Сравнены чистый доход, нагрузка и качество жизни за год.'], 'Выбрать следующий шаг по совокупности дохода, интереса и устойчивости.'],
    ],
  },
  product: {
    label: 'Свой продукт через проверку спроса',
    reason: 'Выбран продуктовый путь. Сначала проверить повторяющуюся проблему и готовность платить, затем ограничить стоимость прототипа. Будущие пользователи, продажи и доход не считаются существующими; большой объём разработки сам по себе спрос не подтверждает.',
    nextStep: 'Записать одну проблему определённой группы пользователей и 5 вопросов о том, как они решают её сейчас.',
    pivotEvidence: ['После 5 интервью нет повторяющейся проблемы с заметной ценой — поменять проблему или аудиторию.', 'После демонстрации минимального решения нет готовности использовать или оплачивать его — выяснить причину до расширения разработки.', 'Достигнут согласованный предел времени или расходов без платного сигнала — остановить вложения и сравнить услугу или карьерный тест.'],
    stages: [
      ['Найти задачу до разработки', ['Выбрана 1 аудитория покупателей и описана 1 повторяющаяся проблема.', 'Проведены первые 3 разговора о текущем решении, затратах и о том, кто принимает решение об оплате.', 'Задан предел времени и расходов; первые разговоры и описание решения используют доступные инструменты без новых покупок.'], 'Проверить, как покупатель решает проблему сегодня и за какой результат уже платит.'],
      ['Проверить прототип и предпродажу', ['Проведены 5 интервью с потенциальными покупателями; показан 1 маленький прототип одной основной функции.', 'Не менее 3 покупателям предложены конкретный результат, цена и условия пилота или подписки. Интерес, письменное намерение и полученная оплата записаны отдельно.', 'Цель — первый платный пилот или предпродажа с понятными условиями; до новых расходов записано решение продолжать, изменить или остановить проверку.'], 'Показать минимальный результат, предложить понятные условия и проверить готовность платить до расширения разработки.'],
      ['Проверить повторное использование и экономику', ['Есть данные о повторном использовании и фактических оплатах.', 'Посчитаны расходы на привлечение, обслуживание и рабочее время.', 'Выбран 1 сегмент либо принято решение изменить направление.'], 'Развивать только часть решения с подтверждённым повторным спросом.'],
      ['Выбирать масштаб по фактической экономике', ['Три месяца подряд учитываются чистые поступления и все расходы.', 'Рост расходов имеет проверяемую связь с удержанием и оплатами.', 'Сравнены продукт, услуга и карьера по чистому доходу и нагрузке.'], 'Увеличивать масштаб только после проверки экономической устойчивости.'],
    ],
  },
};

/**
 * Answers used: focusDirection, planNextStep (or next_step), planFxRate,
 * planFxDate, planStartingCapital, planStartDate. All are existing string fields.
 * Context valuation is an explicitly supplied, dated reference quote; this
 * function never fetches or assumes a current exchange rate.
 * Optional currentPlan is a manually reviewed personalization, not an inference
 * from free-text answers: { direction, reason, nextStep, facts: [...], coaching }.
 * Coaching remains bounded plain-text display data. The renderer must escape
 * its text; accepting any proposed habit is a separate explicit state mutation.
 */
export function buildPersonalPlan(state = {}, context = null, today = new Date()) {
  const now = dayKey(today), profile = state.profile || {}, answers = state.answers || {};
  const goalDate = validKey(profile.goalDate);
  const goalAmount = moneyValue(profile.goalAmount);
  const eligible = profile.currency === 'USD' && profile.goalKind === 'capital' && goalAmount !== null && goalAmount > 0 && goalDate !== null;
  const fx = chosenFx(answers, context, now);
  const base = baseline(state, context, now, eligible, fx);
  const totalMonths = base.start && goalDate ? monthsBetween(base.start, goalDate) : null;
  const monthsRemaining = goalDate ? monthsBetween(now, goalDate) : null;
  const goalGap = base.value !== null && eligible ? Math.max(0, goalAmount - base.value) : null;
  const { record, month } = selectedRecord(state, now);
  const expenses = eligible ? moneyValue(record?.expenses) : null;
  const knownIncome = eligible ? moneyValue(record?.income) : null;
  const monthlySurplus = expenses !== null && knownIncome !== null ? knownIncome - expenses : null;
  const recordCapital = eligible && moneyValue(record?.assets) !== null && moneyValue(record?.debts) !== null ? record.assets - record.debts : null;
  const currentCapital = month ? recordCapital : base.value;
  const currentCapitalDate = currentCapital === null ? null : (month || base.start);
  const annualCheckpoints = [];
  if (base.start && goalDate && totalMonths > 0) {
    let previousDue = base.start, previousShare = 0;
    for (let i = 0; i < SHARES.length; i++) {
      const nominalDue = i === 4 ? goalDate : dateAtMonths(base.start, totalMonths * (i + 1) / 5);
      const due = nominalDue <= base.start ? keyFromSerial(serial(base.start) + 1) : nominalDue;
      // Very short deadlines can put multiple nominal stages on one day.
      // Keep their combined final target instead of dividing by a zero phase.
      const previous = annualCheckpoints.at(-1);
      if (previous?.due === due) {
        previous.cumulativeShare = SHARES[i];
        previous.capitalTarget = goalGap === null ? null : round(base.value + goalGap * SHARES[i]);
        previous.requiredMonthlySurplus = goalGap === null || previous.phaseMonths <= 0 ? null : round(goalGap * (SHARES[i] - previous.previousShare) / previous.phaseMonths);
        previous.requiredNetIncome = expenses !== null && previous.requiredMonthlySurplus !== null ? round(expenses + previous.requiredMonthlySurplus) : null;
        previousShare = SHARES[i];
        continue;
      }
      const phaseMonths = monthsBetween(previousDue, due);
      const requiredMonthlySurplus = goalGap === null || phaseMonths <= 0 ? null : round(goalGap * (SHARES[i] - previousShare) / phaseMonths);
      annualCheckpoints.push({
        id: `plan-capital-${i + 1}`, due,
        capitalTarget: goalGap === null ? null : round(base.value + goalGap * SHARES[i]),
        phaseMonths, cumulativeShare: SHARES[i], previousShare,
        requiredMonthlySurplus,
        requiredNetIncome: expenses !== null && requiredMonthlySurplus !== null ? round(expenses + requiredMonthlySurplus) : null,
      });
      previousDue = due; previousShare = SHARES[i];
    }
  }
  function targetAt(due) {
    if (goalGap === null || !base.start || !goalDate || !(totalMonths > 0)) return { capitalTarget: null, requiredMonthlySurplus: null, requiredNetIncome: null };
    const stage = annualCheckpoints.find(point => point.due >= due) || annualCheckpoints.at(-1);
    const index = annualCheckpoints.indexOf(stage);
    const previousDue = index ? annualCheckpoints[index - 1].due : base.start;
    const elapsed = monthsBetween(previousDue, due);
    const proportion = stage.phaseMonths > 0 ? Math.min(1, elapsed / stage.phaseMonths) : 1;
    const share = stage.previousShare + (stage.cumulativeShare - stage.previousShare) * proportion;
    return { capitalTarget: round(base.value + goalGap * share), requiredMonthlySurplus: stage.requiredMonthlySurplus, requiredNetIncome: stage.requiredNetIncome };
  }
  const chosen = ['service', 'career', 'product'].includes(answers.focusDirection);
  const reviewedDirection = ['service', 'career', 'product'].includes(context?.currentPlan?.direction) ? context.currentPlan.direction : null;
  const direction = chosen ? answers.focusDirection : reviewedDirection || 'service';
  const matchingReviewedPlan = reviewedDirection === direction ? context.currentPlan : null;
  const route = DIRECTIONS[direction];
  const dailyMinutes = known(profile.dailyMinutes) && profile.dailyMinutes > 0 ? profile.dailyMinutes : null;
  const focus = {
    direction, label: route.label, isHypothesis: true, chosenByUser: chosen,
    reason: text(matchingReviewedPlan?.reason) || route.reason, pivotEvidence: [...route.pivotEvidence],
    nextStep: text(answers.planNextStep) || text(matchingReviewedPlan?.nextStep) || text(answers.next_step) || route.nextStep,
    dailyMinutes,
  };
  const anchor = base.start;
  const capDue = due => goalDate && due > goalDate ? goalDate : due;
  const dates = anchor ? [capDue(keyFromSerial(serial(anchor) + 7)), capDue(addMonths(anchor, 1)), capDue(addMonths(anchor, 6)), capDue(addMonths(anchor, 12)), goalDate] : [null, null, null, null, goalDate];
  const horizonNames = ['week', 'month', 'halfyear', 'year', 'fiveyears'];
  const milestones = horizonNames.map((horizon, index) => {
    const stage = route.stages[index];
    const capital = dates[index] ? targetAt(dates[index]) : { capitalTarget: null, requiredMonthlySurplus: null, requiredNetIncome: null };
    const acceptance = stage ? [...stage[1]] : ['Чистый капитал сопоставлен с целью в одной валюте, с датой оценки и известными обязательствами.', 'Отдельно проверены ликвидный резерв, рабочее время, отношения и удовлетворённость жизнью.', 'Расхождение с целью разобрано по фактическим данным; следующий срок и действия пересмотрены.'];
    if (index === 0) acceptance.unshift('Подтверждены охват капитала, дата оценки и расходы; неизвестные суммы остаются неизвестными.');
    if (index > 0) acceptance.push('Сравнены фактическое накопление и денежный ориентир этапа; дефицит не покрывается вымышленной доходностью.');
    acceptance.push(index === 0 ? 'Выбрана одна посильная привычка восстановления; сделаны 4 короткие отметки состояния.' : 'Проведён обзор нагрузки и самочувствия; при ухудшении восстановление и план действий пересмотрены.');
    return {
      id: `personal-${direction}-${horizon}`, horizon, due: dates[index],
      title: stage ? stage[0] : 'Проверить финансовую цель и желаемую жизнь',
      ...capital, acceptance,
      action: index === 0 ? focus.nextStep : stage ? stage[2] : 'Зафиксировать результат и выбрать следующий жизненный и финансовый ориентир.',
    };
  });
  const assumptions = [
    'Денежная лестница — выбранное допущение плана: к 20%, 40%, 60%, 80% и 100% срока накопить 5%, 15%, 35%, 65% и 100% недостающего капитала. Это не прогноз роста дохода.',
    'Доходность активов принята равной нулю. Изменения рыночной цены, курсов, налоги и издержки продажи не рассчитаны; стоимость недвижимости не равна доступным для расходов деньгам.',
    'Нужный чистый доход = известные расходы за месяц + требуемое пополнение капитала. Неизвестные расходы и неполный семейный доход не превращаются в ноль.',
    'Старт и денежные этапы фиксированы. Новые финансовые записи обновляют текущий результат и расходы, но не переносят начало пути.',
    'Число разговоров, предложений и результатов — практические ориентиры для эксперимента, а не гарантии продаж и не научно установленная норма.',
  ];
  if (!eligible) assumptions.push('Для этого денежного сценария выберите цель «капитал» в USD; другие валюты и цели не пересчитываются автоматически.');
  if (fx.incompleteOverride) assumptions.push('Пользовательский курс задан не полностью или некорректно: нужны положительное число рублей за USD и существующая дата не позднее сегодня. Справочный курс не подставлен вместо вашего ввода.');
  if (base.source === 'reference-fx') assumptions.push('Исходный капитал приблизительно пересчитан по явно указанному датированному справочному курсу из исходного контекста. Это оценка до издержек продажи, а не котировка на сегодня.');
  if (base.source === 'user-fx') assumptions.push('Исходный капитал приблизительно пересчитан по вашему курсу и дате. Это сценарий оценки, а не автоматически проверенная рыночная стоимость.');
  if (monthsRemaining === 0 && goalGap > 0) assumptions.push('Срок цели наступил или прошёл. Положительный остаток нельзя распределить на оставшиеся месяцы: выберите новый срок.');
  if (dailyMinutes !== null) assumptions.push(`Доступный бюджет — ${dailyMinutes} минут в день. Один следующий шаг выбирайте внутри этого бюджета; объём целей этапа можно уменьшить после обзора.`);
  const facts = [
    ...(Array.isArray(context?.findings) ? context.findings : []),
    ...(Array.isArray(context?.currentPlan?.facts) ? context.currentPlan.facts : []),
  ];
  return {
    planStartDate: base.start, goalDate, assumptions,
    financial: {
      currency: 'USD', scope: profile.goalScope === 'family' ? 'family' : 'personal', eligible,
      source: base.source, fxRate: ['reference-fx', 'user-fx'].includes(base.source) ? fx.rate : null,
      fxDate: ['reference-fx', 'user-fx'].includes(base.source) ? fx.date : null,
      fxSourceUrl: ['reference-fx', 'user-fx'].includes(base.source) ? fx.sourceUrl : null,
      startingCapital: round(base.value), goalAmount: eligible ? goalAmount : null, goalGap: round(goalGap),
      monthsRemaining, totalMonths, expenses, knownIncome, monthlySurplus,
      currentCapital: round(currentCapital), currentCapitalDate, currentFinancialPeriod: month,
      averageRequiredMonthlySurplus: goalGap === null ? null : goalGap === 0 ? 0 : totalMonths > 0 ? round(goalGap / totalMonths) : null,
      remainingRequiredMonthlySurplus: currentCapital === null || !eligible ? null : currentCapital >= goalAmount ? 0 : monthsRemaining > 0 ? round((goalAmount - currentCapital) / monthsRemaining) : null,
      annualCheckpoints,
      limitation: 'Требуемые накопления, не прогноз. Оценка имущества приблизительна; курс и стоимость могут измениться. Семейный доход должен быть полным, расходы — измеренными. Финансовые цели не заменяют здоровье, отношения и собственный выбор.',
    },
    focus, milestones, coaching: sanitizeCoaching(matchingReviewedPlan?.coaching),
    factBasis: facts.filter(item => item && typeof item.title === 'string').map(item => ({ title: item.title, detail: text(item.detail), url: text(item.url) })),
  };
}

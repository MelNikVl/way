import { dateKey } from './core.mjs';
import { questionGroups } from './content.mjs';
import { buildPersonalPlan, personalIncomeProgress } from './personal-plan.mjs';

const DAY = 86_400_000;
const text = (value, limit = 2000) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const number = value => typeof value === 'number' && Number.isFinite(value);
const score = value => number(value) && value >= 0 && value <= 10;
function serial(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [year, month, day] = key.split('-').map(Number), date = new Date(0);
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() / DAY : null;
}
const keyFromSerial = day => new Date(day * DAY).toISOString().slice(0, 10);
const validMonth = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
function moneyAnswer(value) {
  const raw = text(value);
  if (!/^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(raw)) return null;
  const parsed = Number(raw.replace(',', '.'));
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1e12 ? parsed : null;
}
function meaningfulReview(review) {
  if (!review || typeof review !== 'object') return false;
  return ['win', 'hard', 'next', 'output'].some(key => text(review[key]))
    || ['satisfaction', 'autonomy'].some(key => score(review[key]))
    || ['conversations', 'offers', 'paidPilots'].some(key => number(review[key]) && review[key] >= 0);
}
function currentAI(review, today) {
  if (!review || review.version !== 1 || review.status !== 'accepted' || typeof review.generatedAt !== 'string') return null;
  const timestamp = Date.parse(review.generatedAt), age = today.getTime() - timestamp;
  return Number.isFinite(timestamp) && age >= 0 && age <= 7 * DAY ? review : null;
}
function completedTaskSnapshot(raw) {
  if (typeof raw !== 'string' || raw.length > 10000) return null;
  try {
    const item = JSON.parse(raw);
    if (!item || typeof item !== 'object' || Array.isArray(item) || !text(item.title) || !text(item.action)
      || !number(item.minutes) || item.minutes < 0 || item.minutes > 1440 || !['plan', 'ai'].includes(item.source)
      || typeof item.minimum !== 'string' || typeof item.doneWhen !== 'string') return null;
    return { title: text(item.title, 300), action: text(item.action), minutes: item.minutes,
      minimum: text(item.minimum), doneWhen: text(item.doneWhen), source: item.source };
  } catch { return null; }
}

/** A small, deterministic daily view. It never changes answers or marks work done. */
export function buildToday(state = {}, context = null, { today = new Date(), aiReview = null } = {}) {
  const date = dateKey(today), todaySerial = serial(date), currentMonth = date.slice(0, 7);
  const plan = buildPersonalPlan(state, context, today), answers = state.answers || {}, milestones = state.milestones || {};
  const proposedStart = context?.valuation?.planStartDate;
  const start = serial(proposedStart) !== null && proposedStart <= date ? proposedStart
    : serial(state.startedAt) !== null && state.startedAt <= date ? state.startedAt : date;
  const startSerial = serial(start), dayOffset = todaySerial - startSerial;
  const weekStart = startSerial + Math.floor(dayOffset / 7) * 7, weekEnd = weekStart + 6;
  const weekDates = Array.from({ length: 7 }, (_, i) => keyFromSerial(weekStart + i));
  const elapsedDates = weekDates.filter(key => key <= date);
  const completed = elapsedDates.filter(key => milestones[`today-step-${key}`] === true).length;
  const reviewDates = Object.keys(state.reviews || {}).filter(key => serial(key) !== null && key <= date && meaningfulReview(state.reviews[key])).sort();
  const lastReviewDate = reviewDates.at(-1) || null;
  const reviewDue = lastReviewDate ? todaySerial - serial(lastReviewDate) >= 7 : dayOffset >= 7;
  const budgetMinutes = number(state.profile?.dailyMinutes) && state.profile.dailyMinutes >= 1
    ? Math.min(1440, state.profile.dailyMinutes) : 15;
  const firstWeekStep = dayOffset < 7 ? plan.coaching?.weeklyRhythm.find(item => item.day === dayOffset + 1) : null;
  const freshReviewNext = lastReviewDate && todaySerial - serial(lastReviewDate) < 7 ? text(state.reviews[lastReviewDate].next) : '';
  let chosen;
  if (firstWeekStep) chosen = { ...firstWeekStep, source: 'plan', doneWhen: firstWeekStep.output };
  else if (dayOffset < 7) chosen = {
    title: 'Один шаг по вашему плану', action: plan.focus.nextStep,
    minutes: Math.min(15, budgetMinutes), minimum: 'Записать одно конкретное действие и начать с двух минут.', source: 'plan', doneWhen: '',
  };
  else chosen = {
    title: freshReviewNext ? 'Шаг из последнего обзора' : 'Выбрать следующий маленький шаг',
    action: freshReviewNext || text(answers.planNextStep) || 'Запишите один результат прошедшей недели и выберите одно действие, которое поможет проверить следующий шаг. План первой недели завершён; повторять его автоматически не нужно.',
    minutes: Math.min(10, budgetMinutes), minimum: 'Записать один результат и одно следующее действие.', source: 'plan', doneWhen: 'Выбрано одно посильное действие.',
  };
  const ai = currentAI(aiReview, today);
  const aiAction = Array.isArray(ai?.actions) ? ai.actions.slice(0, 7).find(item => item?.date === date
    && text(item.title) && text(item.action) && number(item.minutes) && item.minutes >= 0 && item.minutes <= 1440) : null;
  if (aiAction) chosen = { title: text(aiAction.title, 300), action: text(aiAction.action), minutes: aiAction.minutes,
    minimum: text(aiAction.minimum) || 'Начать с двух минут.', doneWhen: text(aiAction.doneWhen), source: 'ai' };
  const shortened = chosen.minutes > budgetMinutes;
  const task = {
    key: `today-step-${date}`, title: text(chosen.title, 300),
    action: shortened && text(chosen.minimum) ? text(chosen.minimum) : text(chosen.action),
    minutes: Math.min(chosen.minutes, budgetMinutes), minimum: text(chosen.minimum), source: chosen.source,
    completed: milestones[`today-step-${date}`] === true,
    doneWhen: shortened ? 'Сделана посильная короткая версия; больший объём сегодня не обязателен.' : text(chosen.doneWhen),
  };
  if (task.completed) {
    const snapshot = completedTaskSnapshot(answers[`todayTask_${date}`]);
    Object.assign(task, snapshot || {
      title: 'Основной шаг сегодня выполнен',
      action: 'Вы отметили основной шаг выполненным. Его описание не было сохранено; новый совет не считается выполненным автоматически.',
      minutes: null, minimum: '', doneWhen: '', source: 'plan',
    });
  }

  const entry = state.entries?.[date] || {}, missingScores = [!score(entry.mood) ? 'настроение' : null, !score(entry.energy) ? 'энергию' : null].filter(Boolean);
  const pending = [];
  if (missingScores.length) pending.push({ id: `checkin-${date}`, title: 'Как вы сегодня?', detail: `Отметьте ${missingScores.join(' и ')} по шкале 0–10. Это займёт меньше минуты.`, target: 'checkin' });
  const aiQuestions = [];
  const seenQuestions = new Set();
  for (const question of Array.isArray(ai?.questions) ? ai.questions.slice(0, 5) : []) {
    const id = question?.id;
    if (typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,76}$/.test(id) || seenQuestions.has(id)
      || !text(question.question) || text(answers[`ai_${id}`])) continue;
    seenQuestions.add(id);
    aiQuestions.push({ id: `ai-question-${id}`, title: text(question.question), detail: text(question.reason),
      target: 'ai-question', questionId: id, answerKey: `ai_${id}`, required: question.required === true });
  }
  pending.push(...aiQuestions.filter(item => item.required));
  if (reviewDue) pending.push({ id: `review-${date}`, title: 'Подвести итоги недели',
    detail: 'Запишите, что получилось, что мешало и один следующий шаг. Пропущенные дни отрабатывать не нужно.', target: 'review' });
  const income = personalIncomeProgress(state, 'USD', today), previousMonth = income.periodMonths.at(-1);
  if (!income.records.some(item => item.month === previousMonth)) pending.push({ id: `income-${previousMonth}`, title: 'Записать личный заработок',
    detail: `За ${previousMonth}: ваш доход после налогов и расходов на проекты в USD. Пустое поле означает «пока неизвестно».`, target: 'income', month: previousMonth });
  const household = context?.householdBudget;
  const statedCosts = number(household?.rentalCostsRub) && household.rentalCostsRub >= 0;
  const recordedCosts = moneyAnswer(answers.budgetRentalCostsRub) !== null && validMonth(answers.budgetCostsMonth) && answers.budgetCostsMonth <= currentMonth;
  if (household && !statedCosts && !recordedCosts) pending.push({ id: 'budget-rental-costs', title: 'Уточнить расходы по аренде',
    detail: 'Запишите фактические расходы и налоги по аренде в RUB. Это поможет отделить поступления от доступных семейных денег.', target: 'budget', month: previousMonth });
  const unanswered = questionGroups.flatMap(group => group.questions).filter(([key]) => !text(answers[key]));
  if (unanswered.length) pending.push({ id: 'questions', title: 'Дополнить ответы о себе',
    detail: `Осталось ${unanswered.length} вопросов. Можно ответить на один или вернуться позже.`, target: 'questions' });
  pending.push(...aiQuestions.filter(item => !item.required));
  const stateSummary = score(entry.mood) && score(entry.energy) ? `Сегодня отмечены настроение ${entry.mood}/10 и энергия ${entry.energy}/10.`
    : score(entry.mood) ? `Настроение отмечено: ${entry.mood}/10. Энергия пока не отмечена.`
    : score(entry.energy) ? `Энергия отмечена: ${entry.energy}/10. Настроение пока не отмечено.`
    : 'Настроение и энергия за сегодня пока не отмечены.';
  const summary = [
    `${task.completed ? 'Сегодня основной шаг отмечен выполненным.' : 'Сегодня основной шаг ещё не отмечен выполненным.'} За текущую неделю отмечено шагов: ${completed} из ${elapsedDates.length} прошедших дней.`,
    stateSummary,
    task.completed ? 'На сегодня основной шаг закрыт. Можно оставить время для восстановления.' : `Следующий маленький шаг: ${task.minimum || task.action}`,
  ];
  return {
    date, task, pending: pending.slice(0, 3), summary,
    week: { start: keyFromSerial(weekStart), end: keyFromSerial(weekEnd), completed, elapsed: elapsedDates.length, planned: 7,
      reviewDue, lastReviewDate, needsPlanReview: dayOffset >= 7 && !aiAction && !freshReviewNext },
  };
}

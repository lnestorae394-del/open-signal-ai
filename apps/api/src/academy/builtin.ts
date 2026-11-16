import type { AcademyCategoryInput, AcademyLessonInput } from '@open-signal/shared';

/**
 * Starter course shown while the shared Academy has no lessons of its own.
 * The owner can copy it into the database from the admin panel and then edit,
 * extend or remove it. Ids are fixed so user progress survives the copy.
 */
type L = { ru: string; uk: string; en: string };

export const BUILTIN_CATEGORIES: (AcademyCategoryInput & { id: string })[] = [
  { id: 'basics', order: 10, published: true, title: { ru: 'Основы', uk: 'Основи', en: 'Basics' } },
  { id: 'structure', order: 20, published: true, title: { ru: 'Структура и ликвидность', uk: 'Структура і ліквідність', en: 'Structure and liquidity' } },
  { id: 'zones', order: 30, published: true, title: { ru: 'Зоны интереса', uk: 'Зони інтересу', en: 'Areas of interest' } },
  { id: 'risk', order: 40, published: true, title: { ru: 'Риск и психология', uk: 'Ризик і психологія', en: 'Risk and psychology' } },
];

const lesson = (id: string, categoryId: string, order: number, durationMin: number, title: L, summary: L, body: L): AcademyLessonInput & { id: string } => ({
  id,
  categoryId,
  order,
  durationMin,
  title,
  summary,
  body,
  videoUrl: null,
  pdfUrl: null,
  published: true,
});

export const BUILTIN_LESSONS: (AcademyLessonInput & { id: string })[] = [
  lesson('l1', 'basics', 10, 6,
    { ru: 'Введение в Smart Money', uk: 'Вступ до Smart Money', en: 'Introduction to Smart Money' },
    { ru: 'Что такое концепция Smart Money и чего от неё ждать.', uk: 'Що таке концепція Smart Money і чого від неї чекати.', en: 'What the Smart Money concept is and what to expect from it.' },
    {
      ru: '## Идея подхода\nSmart Money — способ читать график через действия крупных участников: где они набирают позиции и где забирают ликвидность у толпы.\n\nЭто не волшебная формула. Это набор понятий — структура, ликвидность, зоны интереса, — которые помогают описывать движение цены последовательно.\n\n## Как проходить курс\nУроки идут по порядку: каждый следующий опирается на предыдущий. Отрабатывайте понятия на истории графиков, прежде чем применять их в реальной торговле.',
      uk: '## Ідея підходу\nSmart Money — спосіб читати графік через дії великих учасників: де вони набирають позиції і де забирають ліквідність у натовпу.\n\nЦе не чарівна формула. Це набір понять — структура, ліквідність, зони інтересу, — які допомагають описувати рух ціни послідовно.\n\n## Як проходити курс\nУроки йдуть по порядку: кожен наступний спирається на попередній. Відпрацьовуйте поняття на історії графіків, перш ніж застосовувати їх у реальній торгівлі.',
      en: '## The idea\nSmart Money is a way to read a chart through the actions of large participants: where they build positions and where they take liquidity from the crowd.\n\nIt is not a magic formula. It is a set of concepts — structure, liquidity, areas of interest — that help you describe price movement consistently.\n\n## How to take the course\nLessons go in order: each one builds on the previous one. Practise the concepts on historical charts before using them in real trading.',
    }),
  lesson('l2', 'basics', 20, 8,
    { ru: 'Структура рынка', uk: 'Структура ринку', en: 'Market structure' },
    { ru: 'Максимумы и минимумы: как определить тренд и диапазон.', uk: 'Максимуми та мінімуми: як визначити тренд і діапазон.', en: 'Highs and lows: how to tell a trend from a range.' },
    {
      ru: '## Восходящая и нисходящая структура\nВосходящая структура — каждый новый максимум и минимум выше предыдущего (HH и HL). Нисходящая — каждый новый максимум и минимум ниже (LH и LL).\n\n## Диапазон\nЕсли цена ходит между двумя уровнями и не обновляет их, рынок во флэте. В диапазоне сигналы пробоя ненадёжны.\n\n## Практика\nОтметьте на графике последние пять значимых максимумов и минимумов. Определите структуру на старшем таймфрейме, затем на младшем.',
      uk: '## Висхідна і низхідна структура\nВисхідна структура — кожен новий максимум і мінімум вищий за попередній (HH і HL). Низхідна — кожен новий максимум і мінімум нижчий (LH і LL).\n\n## Діапазон\nЯкщо ціна ходить між двома рівнями й не оновлює їх, ринок у флеті. У діапазоні сигнали пробою ненадійні.\n\n## Практика\nПозначте на графіку останні п’ять значущих максимумів і мінімумів. Визначте структуру на старшому таймфреймі, потім на молодшому.',
      en: '## Bullish and bearish structure\nBullish structure means every new high and low is above the previous one (HH and HL). Bearish structure means every new high and low is lower (LH and LL).\n\n## Range\nIf price moves between two levels without breaking them, the market is ranging. Breakout signals are unreliable in a range.\n\n## Practice\nMark the last five significant highs and lows on a chart. Identify the structure on a higher timeframe first, then on a lower one.',
    }),
  lesson('l3', 'structure', 10, 7,
    { ru: 'BOS — слом структуры', uk: 'BOS — злам структури', en: 'BOS — break of structure' },
    { ru: 'Продолжение тренда через обновление ключевого экстремума.', uk: 'Продовження тренду через оновлення ключового екстремуму.', en: 'Trend continuation through a new key extreme.' },
    {
      ru: '## Что такое BOS\nBreak of Structure — закрытие свечи за последним значимым максимумом в восходящем тренде (или минимумом в нисходящем). BOS подтверждает, что тренд продолжается.\n\n## На что смотреть\nВажно закрытие тела свечи, а не только тень. Пробой тенью часто оказывается сбором ликвидности, а не продолжением движения.\n\n## Практика\nНайдите три BOS на истории и отметьте, откуда начался импульс, который их сделал.',
      uk: '## Що таке BOS\nBreak of Structure — закриття свічки за останнім значущим максимумом у висхідному тренді (або мінімумом у низхідному). BOS підтверджує, що тренд триває.\n\n## На що дивитися\nВажливе закриття тіла свічки, а не лише тінь. Пробій тінню часто виявляється збором ліквідності, а не продовженням руху.\n\n## Практика\nЗнайдіть три BOS на історії й позначте, звідки почався імпульс, що їх зробив.',
      en: '## What BOS is\nA Break of Structure is a candle closing beyond the last significant high in an uptrend (or low in a downtrend). A BOS confirms that the trend continues.\n\n## What to watch\nThe candle body close matters, not just the wick. A wick-only break is often a liquidity grab rather than a continuation.\n\n## Practice\nFind three BOS on historical charts and mark where the impulse that made them started.',
    }),
  lesson('l4', 'structure', 20, 7,
    { ru: 'CHoCH — смена характера', uk: 'CHoCH — зміна характеру', en: 'CHoCH — change of character' },
    { ru: 'Первый признак возможного разворота.', uk: 'Перша ознака можливого розвороту.', en: 'The first sign of a possible reversal.' },
    {
      ru: '## Что такое CHoCH\nChange of Character — первый слом структуры против текущего тренда. Например, в восходящем тренде цена закрывается ниже последнего минимума, который дал новый максимум.\n\n## Почему осторожно\nCHoCH — только ранний признак. Подтверждением разворота считают следующий BOS уже в новом направлении.\n\n## Практика\nНайдите на истории CHoCH, за которым последовал разворот, и CHoCH, после которого тренд продолжился. Сравните, чем они отличались.',
      uk: '## Що таке CHoCH\nChange of Character — перший злам структури проти поточного тренду. Наприклад, у висхідному тренді ціна закривається нижче останнього мінімуму, що дав новий максимум.\n\n## Чому обережно\nCHoCH — лише рання ознака. Підтвердженням розвороту вважають наступний BOS уже в новому напрямку.\n\n## Практика\nЗнайдіть на історії CHoCH, після якого стався розворот, і CHoCH, після якого тренд продовжився. Порівняйте, чим вони відрізнялися.',
      en: '## What CHoCH is\nA Change of Character is the first structure break against the current trend. For example, in an uptrend price closes below the last low that produced a new high.\n\n## Why be careful\nA CHoCH is only an early sign. A reversal is considered confirmed by the next BOS in the new direction.\n\n## Practice\nFind a CHoCH followed by a reversal and a CHoCH after which the trend continued. Compare what was different.',
    }),
  lesson('l5', 'structure', 30, 8,
    { ru: 'Ликвидность', uk: 'Ліквідність', en: 'Liquidity' },
    { ru: 'Где скапливаются стоп-ордера и почему цена к ним тянется.', uk: 'Де скупчуються стоп-ордери і чому ціна до них тягнеться.', en: 'Where stop orders cluster and why price is drawn to them.' },
    {
      ru: '## Пулы ликвидности\nЛиквидность скапливается за равными максимумами и минимумами, за очевидными уровнями и линиями тренда — там стоят стоп-ордера и отложенные ордера.\n\n## Сбор ликвидности\nКрупному участнику нужен объём, чтобы войти в позицию. Поэтому цена часто сначала пробивает очевидный уровень, собирает стопы и только потом разворачивается.\n\n## Практика\nОтметьте на графике равные максимумы и минимумы. Проверьте на истории, как часто цена возвращалась к ним.',
      uk: '## Пули ліквідності\nЛіквідність скупчується за рівними максимумами та мінімумами, за очевидними рівнями й лініями тренду — там стоять стоп-ордери та відкладені ордери.\n\n## Збір ліквідності\nВеликому учаснику потрібен обсяг, щоб увійти в позицію. Тому ціна часто спочатку пробиває очевидний рівень, збирає стопи й лише потім розвертається.\n\n## Практика\nПозначте на графіку рівні максимуми та мінімуми. Перевірте на історії, як часто ціна поверталася до них.',
      en: '## Liquidity pools\nLiquidity builds up beyond equal highs and lows, obvious levels and trend lines — that is where stop orders and pending orders sit.\n\n## Liquidity grabs\nA large participant needs volume to enter a position. So price often breaks an obvious level first, takes the stops and only then reverses.\n\n## Practice\nMark equal highs and lows on a chart. Check on history how often price came back to them.',
    }),
  lesson('l6', 'zones', 10, 8,
    { ru: 'Order Blocks', uk: 'Order Blocks', en: 'Order blocks' },
    { ru: 'Последняя противоположная свеча перед импульсом.', uk: 'Остання протилежна свічка перед імпульсом.', en: 'The last opposite candle before an impulse.' },
    {
      ru: '## Определение\nOrder Block — последняя свеча противоположного цвета перед сильным импульсом, который сломал структуру. Считается, что там остались незаполненные ордера крупного участника.\n\n## Качество зоны\nСильнее те блоки, которые сделали BOS, собрали ликвидность перед импульсом и ещё не тестировались.\n\n## Практика\nНайдите пять order block на истории и отметьте, какие из них отработали при первом возврате цены.',
      uk: '## Визначення\nOrder Block — остання свічка протилежного кольору перед сильним імпульсом, що зламав структуру. Вважається, що там залишилися незаповнені ордери великого учасника.\n\n## Якість зони\nСильніші ті блоки, що зробили BOS, зібрали ліквідність перед імпульсом і ще не тестувалися.\n\n## Практика\nЗнайдіть п’ять order block на історії й позначте, які з них відпрацювали при першому поверненні ціни.',
      en: '## Definition\nAn order block is the last opposite-coloured candle before a strong impulse that broke structure. Unfilled orders of a large participant are assumed to remain there.\n\n## Zone quality\nStronger blocks are those that produced a BOS, took liquidity before the impulse and have not been tested yet.\n\n## Practice\nFind five order blocks on historical charts and mark which of them held on the first return of price.',
    }),
  lesson('l7', 'zones', 20, 6,
    { ru: 'Fair Value Gap', uk: 'Fair Value Gap', en: 'Fair value gap' },
    { ru: 'Дисбаланс между тремя свечами.', uk: 'Дисбаланс між трьома свічками.', en: 'An imbalance across three candles.' },
    {
      ru: '## Определение\nFair Value Gap — разрыв между тенью первой и третьей свечи при сильном движении средней свечи. В этом диапазоне цена прошла почти без встречных сделок.\n\n## Как используют\nЦена часто возвращается, чтобы частично заполнить разрыв. FVG рассматривают вместе со структурой и order block, а не как отдельный сигнал.\n\n## Практика\nНайдите на графике FVG и проверьте, заполнила ли цена разрыв полностью, наполовину или не вернулась к нему.',
      uk: '## Визначення\nFair Value Gap — розрив між тінню першої та третьої свічки при сильному русі середньої свічки. У цьому діапазоні ціна пройшла майже без зустрічних угод.\n\n## Як використовують\nЦіна часто повертається, щоб частково заповнити розрив. FVG розглядають разом зі структурою та order block, а не як окремий сигнал.\n\n## Практика\nЗнайдіть на графіку FVG і перевірте, чи заповнила ціна розрив повністю, наполовину чи не повернулася до нього.',
      en: '## Definition\nA fair value gap is the space between the wicks of the first and third candles when the middle candle moves strongly. Price passed through it with almost no opposing trades.\n\n## How it is used\nPrice often comes back to fill part of the gap. An FVG is read together with structure and order blocks, not as a signal on its own.\n\n## Practice\nFind an FVG on a chart and check whether price filled it fully, halfway or never returned.',
    }),
  lesson('l8', 'zones', 30, 6,
    { ru: 'Premium и Discount', uk: 'Premium і Discount', en: 'Premium and discount' },
    { ru: 'Где выгоднее покупать и продавать внутри диапазона.', uk: 'Де вигідніше купувати і продавати всередині діапазону.', en: 'Where buying and selling make more sense within a range.' },
    {
      ru: '## Деление диапазона\nПостройте Фибоначчи от минимума до максимума текущего движения. Выше уровня 50% — зона premium, ниже — discount.\n\n## Правило\nВ восходящей структуре покупки ищут в discount, в нисходящей продажи ищут в premium. Так соотношение риска и цели получается лучше.\n\n## Практика\nДля трёх движений на истории отметьте зоны premium и discount и посмотрите, где находились лучшие точки входа.',
      uk: '## Поділ діапазону\nПобудуйте Фібоначчі від мінімуму до максимуму поточного руху. Вище рівня 50% — зона premium, нижче — discount.\n\n## Правило\nУ висхідній структурі покупки шукають у discount, у низхідній продажі шукають у premium. Так співвідношення ризику й цілі виходить кращим.\n\n## Практика\nДля трьох рухів на історії позначте зони premium і discount і подивіться, де були найкращі точки входу.',
      en: '## Splitting the range\nDraw a Fibonacci from the low to the high of the current move. Above the 50% level is premium, below it is discount.\n\n## The rule\nIn bullish structure look for buys in discount; in bearish structure look for sells in premium. This gives a better risk-to-target ratio.\n\n## Practice\nFor three moves on historical charts, mark premium and discount and see where the best entries were.',
    }),
  lesson('l9', 'risk', 10, 8,
    { ru: 'Управление рисками', uk: 'Управління ризиками', en: 'Risk management' },
    { ru: 'Размер позиции и лимит потерь важнее любой точки входа.', uk: 'Розмір позиції та ліміт втрат важливіші за будь-яку точку входу.', en: 'Position size and a loss limit matter more than any entry.' },
    {
      ru: '## Сколько рисковать\nРискуйте небольшой долей депозита в одной сделке — обычно 1–2%. Тогда серия убыточных сделок не уничтожит счёт.\n\n## Дневной лимит\nЗаранее решите, после какой суммы убытка за день вы прекращаете торговлю. Не пытайтесь отыграться.\n\n## Важно\nТорговля связана с высоким риском потери средств. Никакой сигнал, курс или стратегия не гарантируют прибыль. Торгуйте только теми деньгами, потерю которых можете себе позволить.',
      uk: '## Скільки ризикувати\nРизикуйте невеликою часткою депозиту в одній угоді — зазвичай 1–2%. Тоді серія збиткових угод не знищить рахунок.\n\n## Денний ліміт\nЗаздалегідь вирішіть, після якої суми збитку за день ви припиняєте торгівлю. Не намагайтеся відігратися.\n\n## Важливо\nТоргівля пов’язана з високим ризиком втрати коштів. Жоден сигнал, курс чи стратегія не гарантують прибуток. Торгуйте лише тими грошима, втрату яких можете собі дозволити.',
      en: '## How much to risk\nRisk a small share of your deposit per trade — usually 1–2%. Then a losing streak will not wipe out the account.\n\n## Daily limit\nDecide in advance at what loss for the day you stop trading. Do not try to win it back.\n\n## Important\nTrading carries a high risk of losing money. No signal, course or strategy guarantees profit. Trade only with money you can afford to lose.',
    }),
  lesson('l10', 'risk', 20, 6,
    { ru: 'Психология трейдинга', uk: 'Психологія трейдингу', en: 'Trading psychology' },
    { ru: 'Дисциплина, журнал сделок и работа с эмоциями.', uk: 'Дисципліна, журнал угод і робота з емоціями.', en: 'Discipline, a trading journal and handling emotions.' },
    {
      ru: '## Дисциплина\nТорговый план отвечает на вопросы: что вы торгуете, когда входите, где выходите и сколько рискуете. Если сделка не подходит под план — её нет.\n\n## Журнал\nЗаписывайте каждую сделку: причину входа, результат и своё состояние. Через месяц журнал покажет повторяющиеся ошибки лучше любой теории.\n\n## Эмоции\nСтрах и жадность — нормальны. Справиться с ними помогают пауза после убытка, фиксированный риск и заранее принятые решения.',
      uk: '## Дисципліна\nТорговий план відповідає на питання: що ви торгуєте, коли входите, де виходите і скільки ризикуєте. Якщо угода не підходить під план — її немає.\n\n## Журнал\nЗаписуйте кожну угоду: причину входу, результат і свій стан. За місяць журнал покаже повторювані помилки краще за будь-яку теорію.\n\n## Емоції\nСтрах і жадібність — нормальні. Впоратися з ними допомагають пауза після збитку, фіксований ризик і заздалегідь ухвалені рішення.',
      en: '## Discipline\nA trading plan answers: what you trade, when you enter, where you exit and how much you risk. If a trade does not fit the plan, there is no trade.\n\n## Journal\nWrite down every trade: the reason for entry, the result and how you felt. After a month the journal will show repeated mistakes better than any theory.\n\n## Emotions\nFear and greed are normal. A pause after a loss, a fixed risk and decisions made in advance help you handle them.',
    }),
];

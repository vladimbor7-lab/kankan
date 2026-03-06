import { Hono } from 'npm:hono';
import Anthropic from 'npm:@anthropic-ai/sdk';

const app = new Hono();

// Явный CORS для всех origins включая claude.ai
app.use('*', async (c, next) => {
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (c.req.method === 'OPTIONS') return c.text('', 204);
  await next();
});

const CLAUDE_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-3-5-sonnet-20241022',
  'claude-3-haiku-20240307',
];

async function callClaudeWithFallback(claude: Anthropic, params: any, modelIndex = 0): Promise<any> {
  if (modelIndex >= CLAUDE_MODELS.length) throw new Error('Все модели Claude недоступны');
  const model = CLAUDE_MODELS[modelIndex];
  try {
    return await claude.messages.create({ ...params, model });
  } catch (error: any) {
    if (error.status === 404) return callClaudeWithFallback(claude, params, modelIndex + 1);
    throw error;
  }
}

// Поиск города через Hotellook
async function lookupCity(query: string, token: string): Promise<{ id: string; name: string } | null> {
  try {
    const res = await fetch(
      `https://engine.hotellook.com/api/v2/lookup.json?query=${encodeURIComponent(query)}&lang=ru&lookFor=city&limit=1&token=${token}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const cities = data?.results?.locations;
    if (!cities || cities.length === 0) return null;
    return { id: cities[0].id, name: cities[0].name };
  } catch { return null; }
}

// Поиск отелей через Hotellook cache API
async function searchHotellook(cityId: string, checkIn: string, checkOut: string, adults: number, token: string): Promise<any[]> {
  try {
    const res = await fetch(
      `https://engine.hotellook.com/api/v2/cache.json?location=${cityId}&checkIn=${checkIn}&checkOut=${checkOut}&currency=rub&limit=10&adults=${adults}&token=${token}`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

function generateDemoHotels(location: string, count: number) {
  const names = ['Гранд Отель', 'Ренессанс', 'Меридиан', 'Корона', 'Империал', 'Европа'];
  return Array.from({ length: count }, (_, i) => ({
    id: `demo-${i}`,
    name: `${names[i % names.length]} ${location}`,
    location,
    stars: 3 + Math.floor(Math.random() * 3),
    priceAvg: 3000 + Math.floor(Math.random() * 15000),
    rating: (4.0 + Math.random()).toFixed(1),
    amenities: ['wifi', 'breakfast', 'parking'],
    distance: `${(Math.random() * 5).toFixed(1)} км от центра`,
    demo: true,
  }));
}

// Health check
app.get('/make-server-c3625fc2/health', (c) => {
  return c.json({ status: 'ok', service: 'AI Travel Assistant (Claude)' });
});

// Test Claude
app.post('/make-server-c3625fc2/test-claude', async (c) => {
  try {
    const { claudeApiKey } = await c.req.json();
    if (!claudeApiKey) return c.json({ error: 'Claude API key is required' }, 400);
    const claude = new Anthropic({ apiKey: claudeApiKey });
    const response = await callClaudeWithFallback(claude, {
      max_tokens: 50,
      messages: [{ role: 'user', content: 'Say OK' }],
    });
    return c.json({ success: true, model: response.model });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// AI Chat — главный эндпоинт
app.post('/make-server-c3625fc2/ai-chat', async (c) => {
  try {
    const body = await c.req.json();
    const { message, psychotype, conversationHistory, claudeApiKey, travelpayoutsToken } = body;

    if (!claudeApiKey) return c.json({ error: 'Claude API key is required' }, 400);

    const claude = new Anthropic({ apiKey: claudeApiKey });
    const token = travelpayoutsToken || Deno.env.get('TRAVELPAYOUTS_TOKEN') || '';

    // Шаг 1: Claude извлекает параметры поиска из сообщения
    const extractRes = await callClaudeWithFallback(claude, {
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: `Из сообщения пользователя извлеки параметры поиска отеля.
Сообщение: "${message}"
Верни ТОЛЬКО JSON без markdown:
{"location":"город на английском","checkIn":"YYYY-MM-DD","checkOut":"YYYY-MM-DD","adults":2,"needsHotelSearch":true/false}
Если даты не указаны — используй ближайшие выходные (checkIn: следующая пятница, checkOut: следующее воскресенье).
Если это не запрос отеля — верни {"needsHotelSearch":false}.`
        }
      ],
    });

    let searchParams: any = { needsHotelSearch: false };
    try {
      const text = extractRes.content[0].text.trim().replace(/```json|```/g, '');
      searchParams = JSON.parse(text);
    } catch { /* ignore */ }

    // Шаг 2: Если нужен поиск — ищем через Travelpayouts
    let hotels: any[] = [];
    let hotelsSource = 'none';

    if (searchParams.needsHotelSearch && searchParams.location) {
      const city = await lookupCity(searchParams.location, token);
      if (city) {
        const today = new Date();
        const friday = new Date(today);
        friday.setDate(today.getDate() + ((5 - today.getDay() + 7) % 7 || 7));
        const sunday = new Date(friday);
        sunday.setDate(friday.getDate() + 2);

        const checkIn = searchParams.checkIn || friday.toISOString().split('T')[0];
        const checkOut = searchParams.checkOut || sunday.toISOString().split('T')[0];
        const adults = searchParams.adults || 2;

        const rawHotels = await searchHotellook(city.id, checkIn, checkOut, adults, token);

        if (rawHotels.length > 0) {
          hotels = rawHotels.slice(0, 5).map((h: any) => ({
            id: h.id,
            name: h.name,
            location: `${city.name}`,
            stars: h.stars || 3,
            priceAvg: Math.round(h.priceFrom || 0),
            rating: h.guestScore ? (h.guestScore / 2).toFixed(1) : '4.0',
            amenities: ['wifi'],
            distance: h.distance ? `${h.distance} км от центра` : null,
            photoUrl: h.photoUrl ? `https://photo.hotellook.com/image_v2/limit/${h.photoUrl}/400/300.auto` : null,
            bookingUrl: `https://search.hotellook.com/?destination=${encodeURIComponent(city.name)}&hotelId=${h.id}&checkIn=${checkIn}&checkOut=${checkOut}&adults=${adults}&token=${token}`,
            realPrice: true,
            checkIn,
            checkOut,
          }));
          hotelsSource = 'travelpayouts';
        } else {
          hotels = generateDemoHotels(city.name, 5);
          hotelsSource = 'demo';
        }
      }
    }

    // Шаг 3: Claude генерирует красивый ответ
    const systemPrompt = `Ты — эксперт по подбору туров и отелей для российских туристов.
ПСИХОТИП КЛИЕНТА: ${psychotype || 'Не определён'}
Инструкции по психотипам:
- Экономный: фокус на ценах, акциях, 3-4 звезды
- Комфорт: 4-5 звёзд, SPA, завтраки
- Семейный: детские клубы, бассейны, безопасность
- Романтический: уединение, виды, атмосфера
- Бизнес: центр города, интернет, конференц-залы
- Приключения: экзотика, активности, уникальные места
Отвечай по-русски, дружелюбно и профессионально.`;

    const historyMessages = (conversationHistory || []).map((m: any) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));

    let userContent = message;
    if (hotels.length > 0 && hotelsSource === 'travelpayouts') {
      userContent = `${message}\n\n[Найдены реальные отели через Travelpayouts/Hotellook:]
${hotels.map((h, i) => `${i+1}. ${h.name} — ${h.stars}⭐, от ${h.priceAvg.toLocaleString('ru')} ₽/ночь, рейтинг ${h.rating}`).join('\n')}

Расскажи об этих конкретных отелях с учётом психотипа клиента. Цены реальные — получены через API.`;
    }

    const chatRes = await callClaudeWithFallback(claude, {
      max_tokens: 2000,
      system: systemPrompt,
      messages: [...historyMessages, { role: 'user', content: userContent }],
    });

    const responseText = chatRes.content[0].text;

    return c.json({
      message: responseText,
      hotels,
      hotelsSource,
      functionCalled: hotels.length > 0,
    });

  } catch (error: any) {
    console.error('Error in AI chat:', error);
    let msg = 'Ошибка: ' + error.message;
    if (error.status === 401) msg = 'Неверный Claude API ключ.';
    if (error.status === 429) msg = 'Превышен лимит запросов к Claude.';
    return c.json({ error: msg }, error.status || 500);
  }
});

Deno.serve(app.fetch);

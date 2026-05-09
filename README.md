# Reflect

AI-powered training simulator for psychology students — practice therapy sessions with simulated clients and get supervisor-style feedback.

---

## Що це

Тренувальний кабінет для майбутньої психотерапевтки. Студентка
проводить текстові сесії з AI-клієнткою (Анною), а після завершення
сесії інша модель грає роль супервізора і дає структурований фідбек.

Стек свідомо мінімальний: один NestJS-сервер, SQLite через Prisma,
Angular-фронтенд із чотирма екранами. Ціль першого місяця —
перевірити одну гіпотезу, не побудувати продукт. Деталі —
у [`docs/how_to_start.md`](docs/how_to_start.md).

## Стек

- **Backend**: NestJS 10 + Prisma 6 + SQLite. Два LLM-провайдери: `@anthropic-ai/sdk` і `openai` SDK (через OpenRouter).
- **Frontend**: Angular 19 (standalone components, без UI-фреймворку)
- **Монорепо**: npm workspaces (`backend/`, `frontend/`)

### Голос Анни

- За замовч.: **browser SpeechSynthesis** (`uk-UA`, на macOS — голос «Lesya»). $0, працює локально, але звучить трохи штучно.
- Опція: **ElevenLabs** для якісного озвучення. Додай ключ із [elevenlabs.io](https://elevenlabs.io) у `ELEVENLABS_API_KEY` у [.env](.env). Free-tier дає 10K символів/місяць (вистачить на 4-5 сесій). За замовчуванням використовується голос Charlotte (multilingual). Інший Voice ID — у `ELEVENLABS_VOICE_ID`.
- Frontend пробує ElevenLabs (`/api/tts`); якщо backend без ключа — graceful fallback на browser. Без жодного коду конфігурації на клієнті.

### Вибір LLM-провайдера

Через `LLM_PROVIDER` у [.env](.env):

| `LLM_PROVIDER` | Чат з Анною | Фідбек | Ціна | Особливості |
| --- | --- | --- | --- | --- |
| `anthropic` (за замовч.) | `claude-sonnet-4-6` | `claude-opus-4-7` | платно (≈$0.10–0.30 за сесію) | prompt caching на профілі |
| `openrouter` | `openrouter/owl-alpha` | `openrouter/owl-alpha` | $0 | 50 req/day без credits, 1000 req/day з $10+; 1M context |

Моделі можна перевизначити через `LLM_MODEL_CHAT` і `LLM_MODEL_FEEDBACK` у [.env](.env).

## Вимоги

- Node.js ≥ 20
- API-ключ:
  - **Anthropic** — [console.anthropic.com](https://console.anthropic.com) (потрібно поповнити баланс на $5+)
  - **АБО OpenRouter** — [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) (Google-логін, без картки, безкоштовно)
- (опційно) [ngrok](https://ngrok.com) для доступу з іншого пристрою

## Запуск

```bash
cp .env.example .env          # вписати ключ обраного провайдера
npm install                   # ставить деп-ти і backend, і frontend
npm run db:push               # створює reflect.db (Prisma)
npm start                     # api на :3000 + angular на :4200
```

Відкрий `http://localhost:4200` (Angular dev-server проксує `/api/*`
на NestJS на :3000).

Щоб дати доступ дружині з її ноутбука/телефона — `ngrok http 4200`.

## Структура

```
.
├── package.json                       # workspaces + concurrently
├── .env                               # ANTHROPIC_API_KEY, DATABASE_URL
├── prompts/
│   ├── anna_profile.md                ← ЗАПОВНИ РАЗОМ З ДРУЖИНОЮ
│   ├── anna_system.md                 system-prompt-обгортка для Анни
│   └── supervisor_system.md           prompt для генерації фідбеку
├── docs/
│   ├── how_to_start.md                план на місяць
│   └── anna_template_guide.md         як заповнювати профіль
├── backend/                           NestJS API
│   ├── prisma/schema.prisma           3 моделі: Character, Session, Message
│   └── src/
│       ├── main.ts                    bootstrap, prefix /api, CORS
│       ├── app.module.ts
│       ├── prisma/                    PrismaService
│       ├── prompts/                   читає markdown з ../prompts
│       ├── llm/                       Anthropic / OpenRouter wrapper
│       ├── characters/                GET /api/characters
│       └── sessions/                  POST /api/sessions, /messages, /end
└── frontend/                          Angular 19
    └── src/app/
        ├── app.config.ts              router + http
        ├── app.routes.ts              4 маршрути
        ├── api.service.ts             HttpClient + типізовані DTO
        ├── session-state.service.ts   signals: список бабблів
        └── pages/
            ├── characters-list.component.ts   /
            ├── intro.component.ts             /intro/:id
            ├── chat.component.ts              /session/:id
            └── feedback.component.ts          /session/:id/feedback
```

## Перш ніж писати код — заповни профіль

Це найважливіше. Сервер запуститься і з порожнім профілем — але
Анна звучатиме як AI. **Перший крок — не `npm start`, а
[`prompts/anna_profile.md`](prompts/anna_profile.md) разом з дружиною.**

Логіка тут не технічна, а продуктова: код MVP можна написати за день;
зробити Анну живою — це тиждень роботи з дружиною. Деталі —
у [`docs/anna_template_guide.md`](docs/anna_template_guide.md).

## API

| Метод | Шлях                            | Що робить                                            |
| ----- | ------------------------------- | ---------------------------------------------------- |
| GET   | `/api/characters`               | Список персонажів                                    |
| POST  | `/api/sessions`                 | Нова сесія, повертає першу репліку Анни              |
| POST  | `/api/sessions/:id/messages`    | Додає репліку терапевта, повертає відповідь Анни     |
| POST  | `/api/sessions/:id/end`         | Завершує сесію, повертає фідбек супервізора          |

## Корисні команди

```bash
npm start                  # api + web в dev-режимі
npm run start:api          # тільки NestJS (для одного `node --inspect` тощо)
npm run start:web          # тільки Angular
npm run db:push            # синхронізує Prisma-схему в SQLite (без міграцій)
npm --workspace backend run db:studio   # GUI для SQLite
npm run build              # збірка обох воркспейсів
```

## Що далі

Перші 30 днів — заповнити Анну, провести 5–10 сесій із дружиною,
відстежувати, чи повертається вона сама. Все інше (грантові заявки,
landing page, додаткові персонажі, монетизація) — після того, як
гіпотеза підтвердиться. Жорстка дисципліна обмеження — і є MVP.

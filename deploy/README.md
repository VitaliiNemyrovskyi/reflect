# Deploy — `reflect.swift-mail.app`

Тимчасовий деплой Reflect на ту саму Contabo-VPS, де живе SwiftMail.
Підключаємось через існуючий `bober-web` nginx-ingress (той самий патерн,
що й `app.swift-mail.app` → `swiftmail_web`).

## Архітектура

```
       Cloudflare (proxy + TLS)
              │
              ▼
       Contabo VPS :80
              │
       bober-web (nginx)  ← тримає :80 на хості
              │
   ┌──────────┴──────────┐
   │                     │
reflect_web          reflect_api          (на shared `proxy` docker-network)
(nginx + Angular)    (NestJS + Prisma + SQLite)
                          │
                          └─ volume: reflect_data → /data/reflect.db
```

- **Cloudflare** робить TLS; nginx у контейнері говорить тільки HTTP.
- **bober-web** — nginx-ingress на :80, маршрутизує по `Host:` хедеру.
- **reflect_web** — Angular bundle, обслуговується внутрішнім nginx.
- **reflect_api** — NestJS, SQLite на named docker volume (виживає рестарти).

## Що треба до першого деплою

1. **DNS у Cloudflare** для зони `swift-mail.app`:
   - Тип `A`, ім'я `reflect`, значення = IP сервера (той самий, що в `app`)
   - Proxy: `Proxied` (помаранчева хмарка) — щоб успадкувати TLS
2. **Google OAuth** (опційно — якщо хочемо вхід через Google):
   - https://console.cloud.google.com/apis/credentials → редагуємо OAuth-клієнт
   - В `Authorized redirect URIs` додаємо
     `https://reflect.swift-mail.app/api/auth/google/callback`
3. **Push коду** в GitHub (приватний репо OK):
   ```bash
   gh repo create reflect --private --source=. --push
   ```
4. **SSH-ключ** на сервері — той самий, що для swift-mail.

## Перший деплой

З машини розробника:
```bash
ssh root@<vps-ip>

# Раз — клонуємо репо в /opt/reflect.
git clone git@github.com:<owner>/reflect.git /opt/reflect
cd /opt/reflect

# Раз — створюємо .env.
cp deploy/.env.prod.example .env
# Згенерувати JWT-секрети:
#   openssl rand -base64 48
nano .env

# Деплой.
bash deploy/setup-reflect.sh
```

## Подальші деплої

Простий шлях («тимчасово»):
```bash
ssh root@<vps-ip>
cd /opt/reflect
git pull
docker compose -f docker-compose.prod.yml build --parallel
docker compose -f docker-compose.prod.yml up -d
deploy/reconcile-reflect-ingress.sh   # idempotent
docker image prune -f
```

CI-варіант (на майбутнє): copy `.github/workflows/deploy.yml` зі swift-mail
і поправ шляхи (`/opt/swiftmail` → `/opt/reflect`, `swiftmail_*` → `reflect_*`,
`docker-compose.prod.yml` той самий).

## Корисні команди

```bash
# Тейлити логи (api+web разом)
docker compose -f docker-compose.prod.yml logs -f

# Тільки api
docker compose -f docker-compose.prod.yml logs -f api

# Запустити Prisma Studio (через тунель)
ssh -L 5555:localhost:5555 root@<vps-ip>
docker compose -f docker-compose.prod.yml exec api npx prisma studio --port 5555

# Бекап SQLite
docker compose -f docker-compose.prod.yml exec api sh -c \
  'sqlite3 /data/reflect.db ".backup /data/reflect-backup-$(date +%F).db"'

# Подивитись, що nginx-ingress має наш конфіг
docker exec bober-web-1 cat /etc/nginx/conf.d/reflect.conf

# Хто слухає :80 на хості (debug)
ss -tlnp | grep :80
```

## Troubleshooting

**502 Bad Gateway** після deploy:
- `docker compose ps` — обидва контейнери `Up`?
- `docker compose logs api` — Prisma помилка зазвичай через відсутній `/data` volume
- `bober-web-1` приєднаний до `proxy` мережі? → `deploy/reconcile-reflect-ingress.sh`

**SSE-стрім фідбеку рветься через ~30s**:
- `proxy_read_timeout` уже виставлено на `300s` у `nginx-reflect.conf`
- Якщо все одно рветься — перевір Cloudflare-таймаути (free план обмежує
  100s на запит). Workaround: вимкнути проксі-режим (DNS-only, сіра хмарка)
  і налаштувати TLS через Caddy на сервері.

**OAuth не повертається назад**:
- `API_BASE_URL` у `.env` має бути точно `https://reflect.swift-mail.app`
  (без trailing slash)
- В Google Cloud Console redirect URI має точно збігатись

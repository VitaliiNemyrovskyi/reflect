# Deploy — `reflect.swift-mail.app`

Reflect живе на тій самій Contabo-VPS, що й SwiftMail/Bober, **але повністю
архітектурно ізольований** — свій Caddy-ingress на host :443, свій
Let's Encrypt cert, своя docker-network. Жодних `docker cp` injection-ів
у чужі контейнери, жодної залежності від bober/swiftmail nginx.

## Архітектура

```
                    Browser
                       │
                       ▼  HTTPS (валідний LE cert)
       Contabo VPS host :443
                       │
                  reflect_caddy
              (Let's Encrypt + DNS-01)
                       │
                       │  reflect_net (private docker network)
                       │
            ┌──────────┴──────────┐
            ▼                     ▼
       reflect_web          reflect_api
       (nginx + Angular)    (NestJS + Prisma + SQLite)
                                  │
                                  └─ volume reflect_data → /data/reflect.db
```

- **Cloudflare** для зони — DNS-only (сіра хмара), не проксює. DNS-запит
  повертає реальний IP сервера, браузер з'єднується безпосередньо з Caddy
- **Caddy** тримає :443 хоста, видає валідний Let's Encrypt cert через
  ACME DNS-01 challenge (Cloudflare API token у `.env`). Не потребує :80
  (який тримає bober) — вся валідація через DNS-записи
- **reflect_net** — приватна docker-network тільки для reflect-сервісів.
  bober/swiftmail на іншій (shared `proxy` між ними), не торкаємось

## Що треба до першого деплою

1. **DNS у Cloudflare** для зони `swift-mail.app`:
   - Тип `A`, ім'я `reflect`, значення = IP сервера
   - Proxy: **DNS only** (сіра хмара) — щоб браузер ішов прямо в Caddy
2. **Cloudflare API token** з правами:
   - `Zone → Zone → Read` (для будь-якої зони)
   - `Zone → DNS → Edit` (специфічно для `swift-mail.app`)
3. **Google OAuth** (опційно):
   - https://console.cloud.google.com/apis/credentials
   - В `Authorized redirect URIs` додаємо
     `https://reflect.swift-mail.app/api/auth/google/callback`

## Перший деплой

```bash
ssh deploy@<vps-ip>

# Раз — клонуємо.
git clone https://github.com/<owner>/reflect.git /opt/reflect
cd /opt/reflect

# Раз — конфіг.
cp deploy/.env.prod.example .env
# openssl rand -base64 48  → JWT_ACCESS_SECRET
# openssl rand -base64 48  → JWT_REFRESH_SECRET
# вставити CLOUDFLARE_API_TOKEN, OPENROUTER_API_KEY (або ANTHROPIC_*)
nano .env

bash deploy/setup-reflect.sh
```

Сетап-скрипт:
1. Білдить 3 image: `reflect/api`, `reflect/web`, `reflect/caddy`
2. Піднімає всі контейнери на власній мережі `reflect_net`
3. Caddy робить ACME DNS-01 → Let's Encrypt видає cert (~30 сек)
4. Чекає поки api відповість на health-check

## Подальші деплої

Швидкий шлях (білд локально на M-Mac, push image-tarball на сервер):
```bash
# Локально:
docker buildx build --platform linux/amd64 -f backend/Dockerfile  -t reflect/api:latest --load .
docker buildx build --platform linux/amd64 -f frontend/Dockerfile -t reflect/web:latest --load .
docker save reflect/api:latest reflect/web:latest | gzip -1 \
  | ssh deploy@<vps-ip> 'gunzip | docker load'

# На сервері:
ssh deploy@<vps-ip>
cd /opt/reflect && git pull
docker compose -f docker-compose.prod.yml up -d --force-recreate api web
```

(Caddy-image майже ніколи не міняється — окремий rebuild не потрібен.)

## Корисні команди

```bash
# Тейлити логи
docker compose -f docker-compose.prod.yml logs -f

# Чи cert успішно випущено
docker logs reflect_caddy 2>&1 | grep -E "obtained|certificate"

# Бекап SQLite
docker compose -f docker-compose.prod.yml exec api sh -c \
  'sqlite3 /data/reflect.db ".backup /data/reflect-backup-$(date +%F).db"'

# Подивитись поточний Caddyfile у контейнері
docker exec reflect_caddy cat /etc/caddy/Caddyfile

# Перевірити що :443 справді тримає reflect_caddy
ss -tlnp | grep :443
```

## Troubleshooting

**Caddy не може випустити cert** (`acme: Could not validate`):
- Перевір що `CLOUDFLARE_API_TOKEN` має `Zone DNS Edit` для `swift-mail.app`
- `docker logs reflect_caddy` покаже точну помилку валідації
- Тимчасово можна вручну запустити:
  `docker exec reflect_caddy caddy reload --config /etc/caddy/Caddyfile`

**SSE-стрім фідбеку рветься через ~30s**:
- У `Caddyfile` уже виставлено `read_timeout 300s` для `/api/*`
- Якщо все одно — глянь `docker logs reflect_api` чи запит дійшов

**OAuth не повертається назад**:
- `API_BASE_URL` має бути точно `https://reflect.swift-mail.app` (без trailing slash)
- В Google Cloud Console redirect URI має точно збігатись

**Зник cert / ALPN failure**:
- `caddy_data` volume персистентний — cert + ACME state живуть там, виживають redeploy
- Якщо volume випадково знищили — Caddy просто запросить новий cert при старті (~30 сек)

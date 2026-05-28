# syntax=docker/dockerfile:1.7
FROM python:3.12-slim AS runner

WORKDIR /app

# Install Python deps. --no-cache-dir keeps image small; runtime layer
# stays in the ~120MB range total.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py .

# uvicorn binds to all interfaces; the docker network isolation handles
# external exposure (we never publish this port to the host).
EXPOSE 5050
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5050"]

"""
AmaNotícias — back-end (Flask)
=================================================================
API de notícias em tempo real a partir de feeds RSS.

Configuração:
   - pip install -r requirements.txt
   - python app.py
=================================================================
"""

import html
import json
import os
import re
import threading
import time
import xml.etree.ElementTree as ET
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from urllib.parse import urljoin

from flask import Flask, Response, jsonify, request, send_from_directory
from flask_cors import CORS
from dotenv import load_dotenv
import requests

RSS_FEEDS = {
    "G1": "https://g1.globo.com/rss/g1/",
    "UOL": "https://rss.uol.com.br/feed/noticias.xml",
    "CNN Brasil": "https://www.cnnbrasil.com.br/feed/",
    "Agência Brasil": "https://agenciabrasil.ebc.com.br/rss/ultimasnoticias/feed.xml",
}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"), override=True)

DATA_DIR = os.path.join(BASE_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)
SUBSCRIBERS_FILE = os.path.join(DATA_DIR, "subscribers.json")
COMMENTS_FILE = os.path.join(DATA_DIR, "comments.json")
_data_lock = threading.Lock()

EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

app = Flask(__name__)
CORS(app)

_news_cache = {}
CACHE_TTL_SECONDS = 10 * 60
IMAGE_CACHE = {}
IMAGE_CACHE_TTL_SECONDS = 30 * 60
@app.route("/", methods=["GET"])
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/<path:filename>", methods=["GET"])
def serve_asset(filename):
    if filename in {"index.html", "style.css", "script.js", "Globe.js", "globe.js"}:
        return send_from_directory(BASE_DIR, filename)
    return "Not Found", 404


@app.route("/api/news", methods=["GET"])
def get_news():
    category = request.args.get("category", "general")
    query = request.args.get("q", "").strip()
    page = int(request.args.get("page", 1))
    page_size = 12

    cache_key = ("relevance-v6", category, query, page)
    cached = _news_cache.get(cache_key)
    if cached and (time.time() - cached[0]) < CACHE_TTL_SECONDS:
        return jsonify(cached[1])

    try:
        raw_articles = _fetch_rss_articles(category, query)
    except requests.RequestException as exc:
        return jsonify({
            "error": f"Falha ao consultar as fontes de notícias: {exc}",
            "articles": [],
            "has_more": False,
        }), 502

    start = (page - 1) * page_size
    page_articles = raw_articles[start:start + page_size]
    total_results = len(raw_articles)

    articles = [
        _format_article(item, category)
        for item in page_articles
        if item.get("title") and item.get("title") != "[Removed]"
    ]

    payload = {
        "articles": articles,
        "total_results": total_results,
        "page": page,
        "has_more": page * page_size < total_results,
    }

    _news_cache[cache_key] = (time.time(), payload)
    return jsonify(payload)


def _fetch_rss_articles(category, query):
    category_terms = {
        "technology": "tecnologia inovação internet software celular",
        "business": "economia negócios mercado empresas finanças",
        "sports": "esportes futebol campeonato",
        "health": "saúde medicina vacina",
        "science": "ciência pesquisa espaço",
        "entertainment": "cultura entretenimento cinema música televisão",
    }
    query_terms = _search_terms(query)
    terms = query_terms or _search_terms(category_terms.get(category, ""))
    articles = []

    feed_sources = dict(RSS_FEEDS)
    if query:
        google_query = requests.utils.quote(query)
        feed_sources["Busca"] = (
            "https://news.google.com/rss/search?q="
            f"{google_query}&hl=pt-BR&gl=BR&ceid=BR:pt-419"
        )
        feed_sources["Busca Bing"] = (
            "https://www.bing.com/news/search?q="
            f"{google_query}&format=rss"
        )

    def fetch_feed(source, feed_url):
        try:
            response = requests.get(
                feed_url,
                headers={"User-Agent": "AmaNoticias/1.0"},
                timeout=6,
            )
            response.raise_for_status()
            return source, _parse_rss_xml(response.content, response.encoding)
        except (requests.RequestException, ET.ParseError) as exc:
            print(f"[aviso] fonte RSS indisponível ({source}): {exc}")
            return source, None

    with ThreadPoolExecutor(max_workers=len(feed_sources)) as executor:
        futures = [
            executor.submit(fetch_feed, source, feed_url)
            for source, feed_url in feed_sources.items()
        ]
        feed_results = [future.result() for future in as_completed(futures)]

    for source, root in feed_results:
        if root is None:
            continue
        for item in root.findall(".//item"):
            title = _rss_text(item, "title")
            description_html = _rss_text(item, "description")
            description = _clean_html(description_html)
            image = _extract_image_url(item, description_html)
            searchable = _normalize_search_text(f"{title} {description}")
            if query_terms:
                if not all(term in searchable for term in query_terms):
                    continue
            elif terms and not any(term in searchable for term in terms):
                continue
            articles.append({
                "title": title,
                "description": description,
                "url": _rss_text(item, "link"),
                "image": image,
                "source": source,
                "published_at": _rss_text(item, "pubDate"),
            })

    image_counts = {}
    for article in articles:
        if article["image"]:
            image_counts[article["image"]] = image_counts.get(article["image"], 0) + 1

    candidates = [
        article for article in articles
        if not article["image"] or image_counts.get(article["image"], 0) > 1
    ]
    with ThreadPoolExecutor(max_workers=8) as executor:
        futures = {
            executor.submit(_extract_article_page_image, article["url"]): article
            for article in candidates
            if article["url"]
        }
        for future in as_completed(futures):
            article_image = future.result()
            if article_image:
                futures[future]["image"] = article_image

    seen_images = set()
    for article in articles:
        image = article["image"]
        if image and image in seen_images:
            article["image"] = ""
        elif image:
            seen_images.add(image)

    unique_articles = {}
    for article in articles:
        key = re.sub(r"\W+", "", article["title"].lower())
        unique_articles.setdefault(key, article)
    deduplicated = list(unique_articles.values())
    deduplicated.sort(
        key=lambda article: (
            bool(article.get("image")),
            article.get("published_at") or "",
        ),
        reverse=True,
    )
    return deduplicated


def _parse_rss_xml(content, encoding=None):
    """Faz o parse do XML do feed, tentando corrigir problemas comuns
    (caracteres de controle inválidos, '&' soltos) quando o parse direto falha."""
    try:
        return ET.fromstring(content)
    except ET.ParseError:
        text = content.decode(encoding or "utf-8", errors="replace")
        text = re.sub(r"[\x00-\x08\x0B\x0C\x0E-\x1F]", "", text)
        text = re.sub(r"&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)", "&amp;", text)
        return ET.fromstring(text.encode("utf-8"))


def _rss_text(item, tag):
    element = item.find(tag)
    return (element.text or "").strip() if element is not None else ""


def _normalize_search_text(value):
    normalized = unicodedata.normalize("NFKD", value.lower())
    return "".join(char for char in normalized if not unicodedata.combining(char))


def _search_terms(value):
    stopwords = {
        "a", "as", "o", "os", "um", "uma", "uns", "umas", "de", "do", "da",
        "dos", "das", "em", "no", "na", "nos", "nas", "por", "para", "com",
        "sem", "e", "ou", "que", "sobre", "como", "mais", "menos",
    }
    normalized = _normalize_search_text(value)
    return [
        term for term in re.findall(r"[a-z0-9]{2,}", normalized)
        if term not in stopwords
    ]


def _extract_image_url(item, description_html=""):
    for element in item.iter():
        tag = element.tag.split('}')[-1].lower()
        if tag in {"enclosure", "image", "thumbnail", "content", "media"}:
            url = (
                element.attrib.get("url")
                or element.attrib.get("href")
                or element.attrib.get("src")
                or element.attrib.get("medium")
            )
            if url:
                return _normalize_image_url(url)
        if tag == "image" and element.text:
            image = _normalize_image_url(element.text)
            if image:
                return image

    if description_html:
        match = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', description_html, flags=re.IGNORECASE | re.DOTALL)
        if match:
            return _normalize_image_url(match.group(1))

    return ""


def _normalize_image_url(value, base_url=""):
    value = html.unescape(value.strip())
    if value.startswith("//"):
        return f"https:{value}"
    if value.startswith(("http://", "https://")):
        return value
    if base_url and value.startswith("/"):
        return urljoin(base_url, value)
    return ""


def _extract_article_page_image(url):
    try:
        response = requests.get(
            url,
            headers={"User-Agent": "Mozilla/5.0 (compatible; AmaNoticias/1.0)"},
            timeout=4,
        )
        response.raise_for_status()
    except (requests.RequestException, ValueError):
        return ""

    markup = response.text[:1_500_000]
    patterns = (
        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)[^>]+property=["\']og:image["\']',
        r'"(?:image|contentUrl)"\s*:\s*"([^"]+)"',
        r'"image"\s*:\s*\{\s*"url"\s*:\s*"([^"]+)"',
    )
    for pattern in patterns:
        match = re.search(pattern, markup, flags=re.IGNORECASE)
        if match:
            image = _normalize_image_url(match.group(1), response.url)
            if image:
                return image
    return ""


def _clean_html(value):
    if not value:
        return ""

    text = html.unescape(value)
    text = re.sub(r"<br\s*/?>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _format_article(item, category):
    source = item.get("source")
    if isinstance(source, dict):
        source = source.get("name")
    return {
        "title": item.get("title"),
        "description": _shorten_text(item.get("description") or ""),
        "url": item.get("url"),
        "image": item.get("image") or "",
        "source": source,
        "category": category,
        "published_at": item.get("published_at") or "",
    }


def _fallback_image(category, title, used_images=None):
    safe_title = html.escape(_shorten_text(title, 90))
    safe_category = html.escape(category.title())
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520" '
        'viewBox="0 0 900 520"><rect width="900" height="520" fill="#e9e8e1"/>'
        '<rect x="42" y="42" width="816" height="436" rx="14" fill="#f8f8f4" '
        'stroke="#d8d5c8" stroke-width="3"/>'
        '<text x="60" y="105" fill="#6b7080" font-family="Arial" font-size="24">'
        f'{safe_category}</text><text x="60" y="205" fill="#3a3f4b" font-family="Arial" '
        f'font-size="34">{safe_title}</text></svg>'
    )
    return "data:image/svg+xml;charset=UTF-8," + requests.utils.quote(svg)


def _shorten_text(value, limit=260):
    value = re.sub(r"\s+", " ", value).strip()
    if len(value) <= limit:
        return value
    return value[:limit].rsplit(" ", 1)[0].rstrip(" .,;:") + "..."


@app.route("/api/image", methods=["GET"])
def proxy_image():
    image_url = request.args.get("url", "").strip()
    if not image_url.startswith(("http://", "https://")):
        return "Imagem inválida", 400

    cached = IMAGE_CACHE.get(image_url)
    if cached and (time.time() - cached[0]) < IMAGE_CACHE_TTL_SECONDS:
        return Response(cached[1], mimetype=cached[2], headers={"Cache-Control": "public, max-age=1800"})

    try:
        response = requests.get(
            image_url,
            headers={"User-Agent": "Mozilla/5.0 AmaNoticias/1.0"},
            timeout=5,
        )
        response.raise_for_status()
    except requests.RequestException:
        return "Imagem indisponível", 404

    content_type = response.headers.get("Content-Type", "image/jpeg").split(";")[0]
    if not content_type.startswith("image/"):
        return "Conteúdo inválido", 415
    IMAGE_CACHE[image_url] = (time.time(), response.content, content_type)
    return Response(response.content, mimetype=content_type, headers={"Cache-Control": "public, max-age=1800"})


def _load_json(path, default):
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (json.JSONDecodeError, OSError):
        return default


def _save_json(path, data):
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)


@app.route("/api/subscribe", methods=["POST"])
def subscribe_newsletter():
    """Cadastra um e-mail na lista de novidades (armazenada localmente em
    data/subscribers.json). Não envia e-mail nenhum — isso exigiria um
    provedor de e-mail configurado à parte (SMTP, Mailchimp, etc.)."""
    data = request.get_json(silent=True) or {}
    email = str(data.get("email", "")).strip().lower()

    if not email or not EMAIL_PATTERN.match(email):
        return jsonify({"error": "Digite um e-mail válido."}), 400

    with _data_lock:
        subscribers = _load_json(SUBSCRIBERS_FILE, [])
        if any(entry.get("email") == email for entry in subscribers):
            return jsonify({"ok": True, "message": "Esse e-mail já está cadastrado."})

        subscribers.append({
            "email": email,
            "subscribed_at": datetime.now(timezone.utc).isoformat(),
        })
        _save_json(SUBSCRIBERS_FILE, subscribers)

    return jsonify({"ok": True, "message": "Cadastro feito! Você será avisado das novidades."})


def _today_key():
    return datetime.now().strftime("%Y-%m-%d")


@app.route("/api/comments", methods=["GET"])
def get_comments():
    """Retorna os comentários do mural de hoje (reinicia a cada dia)."""
    with _data_lock:
        board = _load_json(COMMENTS_FILE, {})
        comments = board.get(_today_key(), [])
    return jsonify({"date": _today_key(), "comments": comments})


@app.route("/api/comments", methods=["POST"])
def post_comment():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()[:40] or "Leitor anônimo"
    text = re.sub(r"\s+", " ", str(data.get("text", "")).strip())[:500]

    if not text:
        return jsonify({"error": "Escreva um comentário antes de enviar."}), 400

    comment = {
        "name": name,
        "text": text,
        "time": datetime.now(timezone.utc).isoformat(),
    }

    with _data_lock:
        board = _load_json(COMMENTS_FILE, {})
        today = _today_key()
        day_comments = board.get(today, [])
        day_comments.append(comment)
        board[today] = day_comments[-200:]  # limite de segurança por dia

        # mantém só os últimos 14 dias no arquivo, pra não crescer sem limite
        if len(board) > 14:
            for old_key in sorted(board.keys())[: len(board) - 14]:
                del board[old_key]

        _save_json(COMMENTS_FILE, board)

    return jsonify({"ok": True, "comment": comment})


def _recent_headlines_context(limit=10):
    """Monta uma lista de manchetes reais a partir do cache de notícias já
    buscado pelo site, para servir de contexto (grounding) ao chatbot."""
    now = time.time()
    seen_titles = set()
    headlines = []

    cache_entries = sorted(_news_cache.items(), key=lambda kv: kv[1][0], reverse=True)
    for (_cache_type, category, query, page), (cached_at, payload) in cache_entries:
        if query or page != 1 or (now - cached_at) > CACHE_TTL_SECONDS:
            continue
        for article in payload.get("articles", [])[:5]:
            title = (article.get("title") or "").strip()
            if not title or title in seen_titles:
                continue
            seen_titles.add(title)
            source = article.get("source") or "Fonte desconhecida"
            headlines.append(f"- [{category}] {title} ({source})")
            if len(headlines) >= limit:
                break
        if len(headlines) >= limit:
            break

    return "\n".join(headlines) if headlines else "Nenhuma manchete em cache no momento."


def _sanitize_chat_history(raw_history):
    history = []
    if not isinstance(raw_history, list):
        return history
    for entry in raw_history[-8:]:
        if not isinstance(entry, dict):
            continue
        role = entry.get("role")
        content = str(entry.get("content", "")).strip()
        if role in {"user", "assistant"} and content:
            history.append({"role": role, "content": content[:1000]})
    return history


@app.route("/api/chat", methods=["POST"])
def chat():
    data = request.get_json(silent=True) or {}
    message = str(data.get("message", "")).strip()
    if not message:
        return jsonify({"error": "Digite uma pergunta."}), 400
    if len(message) > 1000:
        return jsonify({"error": "A pergunta deve ter no máximo 1000 caracteres."}), 400

    history = _sanitize_chat_history(data.get("history"))
    system_prompt = (
        "Você é o assistente de notícias do portal AmaNotícias. Responda sempre em "
        "português do Brasil, de forma objetiva, natural e amigável, com respostas "
        "curtas e diretas, a menos que o usuário peça análise mais profunda. Para "
        "perguntas complexas, faça uma resposta estruturada: primeiro a resposta direta, "
        "depois contexto breve, e, quando útil, pontos-chave, impactos e diferenciais. "
        "Você pode conversar sobre qualquer assunto, mas quando a pergunta for sobre "
        "notícias atuais, baseie-se nas manchetes reais abaixo (coletadas agora pelo "
        "próprio site). Nunca invente fatos, datas ou números específicos de notícias "
        "que não estejam nas manchetes fornecidas; se não tiver a informação, diga "
        "isso claramente e sugira usar a busca do site.\n\n"
        f"Manchetes disponíveis agora:\n{_recent_headlines_context()}"
    )

    gemini_key = os.getenv("GEMINI_API_KEY", "").strip()
    if gemini_key:
        try:
            contents = [
                {
                    "role": "user" if item["role"] == "user" else "model",
                    "parts": [{"text": item["content"]}],
                }
                for item in history
            ]
            contents.append({"role": "user", "parts": [{"text": message}]})
            response = requests.post(
                "https://generativelanguage.googleapis.com/v1beta/models/"
                f"{os.getenv('GEMINI_MODEL', 'gemini-3.1-pro-preview')}:generateContent",
                headers={"x-goog-api-key": gemini_key},
                json={
                    "systemInstruction": {"parts": [{"text": system_prompt}]},
                    "contents": contents,
                    "generationConfig": {
                        "temperature": 0.4,
                        "maxOutputTokens": 1200,
                    },
                },
                timeout=20,
            )
            response.raise_for_status()
            payload = response.json()
            answer = payload["candidates"][0]["content"]["parts"][0]["text"].strip()
            if answer:
                return jsonify({"answer": answer, "provider": "ai"})
        except requests.HTTPError as exc:
            detail = ""
            try:
                detail = exc.response.json().get("error", {}).get("message", "")
            except ValueError:
                pass
            status = exc.response.status_code if exc.response is not None else "?"
            print(f"[erro] Gemini indisponível ({status}): {detail or exc}")
        except (requests.RequestException, ValueError, KeyError, IndexError) as exc:
            print(f"[aviso] Gemini indisponível: {exc}")

    anthropic_key = os.getenv("ANTHROPIC_API_KEY", "").strip()
    if anthropic_key:
        try:
            headers = {
                "x-api-key": anthropic_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
            workspace_id = os.getenv("ANTHROPIC_WORKSPACE_ID", "").strip()
            if workspace_id:
                headers["anthropic-workspace-id"] = workspace_id

            response = requests.post(
                "https://api.anthropic.com/v1/messages",
                headers=headers,
                json={
                    "model": os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5"),
                    "max_tokens": 600,
                    "system": system_prompt,
                    "messages": history + [{"role": "user", "content": message}],
                },
                timeout=20,
            )
            response.raise_for_status()
            content = response.json().get("content", [])
            answer = " ".join(part.get("text", "") for part in content if part.get("type") == "text").strip()
            if answer:
                return jsonify({"answer": answer, "provider": "ai"})
        except requests.HTTPError as exc:
            detail = ""
            try:
                detail = exc.response.json().get("error", {}).get("message", "")
            except ValueError:
                pass
            status = exc.response.status_code if exc.response is not None else "?"
            print(f"[erro] Anthropic indisponível ({status}): {detail or exc}")
        except (requests.RequestException, ValueError) as exc:
            print(f"[aviso] Anthropic indisponível: {exc}")

    groq_key = os.getenv("GROQ_API_KEY", "").strip()
    if groq_key:
        try:
            response = requests.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {groq_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": os.getenv("GROQ_MODEL", "openai/gpt-oss-20b"),
                    "messages": [{"role": "system", "content": system_prompt}]
                    + history
                    + [{"role": "user", "content": message}],
                    "temperature": 0.4,
                    "max_tokens": 600,
                },
                timeout=20,
            )
            response.raise_for_status()
            choices = response.json().get("choices", [])
            answer = (choices[0].get("message", {}).get("content", "").strip() if choices else "")
            if answer:
                return jsonify({"answer": answer, "provider": "ai"})
        except requests.HTTPError as exc:
            detail = ""
            try:
                detail = exc.response.json().get("error", {}).get("message", "")
            except ValueError:
                pass
            status = exc.response.status_code if exc.response is not None else "?"
            print(f"[erro] Groq indisponível ({status}): {detail or exc}")
        except (requests.RequestException, ValueError, KeyError, IndexError) as exc:
            print(f"[aviso] Groq indisponível: {exc}")

    ollama_url = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434").strip()
    if ollama_url:
        try:
            response = requests.post(
                f"{ollama_url}/api/chat",
                json={
                    "model": os.getenv("OLLAMA_MODEL", "llama3.1"),
                    "messages": [{"role": "system", "content": system_prompt}]
                    + history
                    + [{"role": "user", "content": message}],
                    "stream": False,
                },
                # o modelo roda na sua máquina, então pode demorar mais que uma API na nuvem
                # (na primeira resposta ele ainda está carregando na memória — por isso o timeout alto)
                timeout=120,
            )
            response.raise_for_status()
            answer = response.json().get("message", {}).get("content", "").strip()
            if answer:
                return jsonify({"answer": answer, "provider": "ai-local"})
        except requests.ConnectionError as exc:
            print(f"[aviso] Ollama indisponível (conexão recusada): {exc}")
        except (requests.RequestException, ValueError) as exc:
            print(f"[aviso] Ollama indisponível: {exc}")

    return jsonify({
        "answer": (
            "No momento não consigo usar a IA para responder. Mas posso ajudar a encontrar "
            f"notícias — use a busca no topo para pesquisar por “{message}” entre as fontes "
            "disponíveis."
        ),
        "provider": "local",
    })


@app.route("/api/health", methods=["GET"])
def health_check():
    gemini_key = bool(os.getenv("GEMINI_API_KEY", "").strip())
    anthropic_key = bool(os.getenv("ANTHROPIC_API_KEY", "").strip())
    ai_model = os.getenv("GEMINI_MODEL", os.getenv("ANTHROPIC_MODEL", "gemini-3.1-pro-preview"))
    return jsonify({
        "status": "ok",
        "time": datetime.now(timezone.utc).isoformat(),
        "news_sources": list(RSS_FEEDS),
        "ai_configured": gemini_key or anthropic_key,
        "ai_model": ai_model,
    })


if __name__ == "__main__":
    app.run(debug=True, port=5000)
/* =========================================================================
   AmaNotícias — script.js
   Consome o back-end Flask (app.py):
     GET /api/news?category=...&q=...&page=...
   ========================================================================= */

const API_BASE_URL = 'http://127.0.0.1:5000';

const state = {
  category: 'general',
  query: '',
  page: 1,
  articles: [],
  loading: false,
  pendingReset: false,
  chatHistory: [],
  aiConfigured: false,
};

const CHAT_SUGGESTIONS = [
  'Quais são as principais notícias de agora?',
  'Resuma as notícias de tecnologia',
  'O que está em alta na economia?',
];

const el = {
  currentDate: document.getElementById('current-date'),
  searchForm: document.getElementById('search-form'),
  searchInput: document.getElementById('search-input'),
  categoryList: document.getElementById('category-list'),
  themeToggleBtn: document.getElementById('theme-toggle-btn'),
  skeletonTemplate: document.getElementById('skeleton-card-template'),
  featuredContent: document.getElementById('featured-content'),
  featuredTemplate: document.getElementById('featured-template'),
  feedError: document.getElementById('feed-error'),
  feedErrorText: document.getElementById('feed-error-text'),
  feedRetryBtn: document.getElementById('feed-retry-btn'),
  newsGrid: document.getElementById('news-grid'),
  newsCardTemplate: document.getElementById('news-card-template'),
  feedCount: document.getElementById('feed-count'),
  feedEmpty: document.getElementById('feed-empty'),
  loadMoreBtn: document.getElementById('load-more-btn'),
  chatbotToggle: document.getElementById('chatbot-toggle'),
  chatbotPanel: document.getElementById('chatbot-panel'),
  chatbotClose: document.getElementById('chatbot-close'),
  chatbotClear: document.getElementById('chatbot-clear'),
  chatbotForm: document.getElementById('chatbot-form'),
  chatbotInput: document.getElementById('chatbot-input'),
  chatbotMessages: document.getElementById('chatbot-messages'),
  chatbotSuggestions: document.getElementById('chatbot-suggestions'),
  chatbotStatus: document.getElementById('chatbot-status'),
  newsletterForm: document.getElementById('newsletter-form'),
  newsletterEmail: document.getElementById('newsletter-email'),
  newsletterFeedback: document.getElementById('newsletter-feedback'),
  readerBoardForm: document.getElementById('reader-board-form'),
  readerBoardName: document.getElementById('reader-board-name'),
  readerBoardText: document.getElementById('reader-board-text'),
  readerBoardList: document.getElementById('reader-board-list'),
  readerBoardEmpty: document.getElementById('reader-board-empty'),
  readerBoardDate: document.getElementById('reader-board-date'),
};

const CATEGORY_LABELS = {
  general: 'Principais',
  technology: 'Tecnologia',
  business: 'Economia',
  sports: 'Esportes',
  health: 'Saúde',
  science: 'Ciência',
  entertainment: 'Cultura',
};

document.addEventListener('DOMContentLoaded', () => {
  renderCurrentDate();
  bindThemeToggle();
  bindCategoryNav();
  bindSearch();
  bindChatbot();
  bindNewsletter();
  bindReaderBoard();
  checkAiStatus();
  loadNews({ reset: true });
  loadComments();
});

async function checkAiStatus() {
  if (!el.chatbotStatus) return;
  try {
    const response = await fetch(`${API_BASE_URL}/api/health`);
    if (!response.ok) throw new Error('status indisponível');
    const data = await response.json();
    state.aiConfigured = Boolean(data.ai_configured);
    el.chatbotStatus.textContent = state.aiConfigured
      ? `IA conectada · ${data.ai_model || 'Claude'}`
      : 'Modo local (sem chave de IA)';
    el.chatbotStatus.classList.toggle('is-online', state.aiConfigured);
    el.chatbotStatus.classList.toggle('is-offline', !state.aiConfigured);
  } catch (err) {
    state.aiConfigured = false;
    el.chatbotStatus.textContent = 'Não foi possível verificar a IA';
    el.chatbotStatus.classList.add('is-offline');
    console.error('Falha ao checar status da IA:', err);
  }
}

function bindThemeToggle() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  el.themeToggleBtn.setAttribute('aria-pressed', String(isDark));
  el.themeToggleBtn.setAttribute(
    'aria-label',
    isDark ? 'Alternar para modo claro' : 'Alternar para modo escuro'
  );

  el.themeToggleBtn.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';

    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('amanoticias-theme', next);
    } catch (e) {
      // localStorage indisponível
    }

    el.themeToggleBtn.setAttribute('aria-pressed', String(next === 'dark'));
    el.themeToggleBtn.setAttribute(
      'aria-label',
      next === 'dark' ? 'Alternar para modo claro' : 'Alternar para modo escuro'
    );
  });
}

function renderSkeletons(count = 6) {
  el.newsGrid.innerHTML = '';
  for (let i = 0; i < count; i += 1) {
    const fragment = el.skeletonTemplate.content.cloneNode(true);
    el.newsGrid.appendChild(fragment);
  }
}

function renderCurrentDate() {
  const now = new Date();
  const formatted = now.toLocaleDateString('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
  el.currentDate.textContent = formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function bindCategoryNav() {
  el.categoryList.addEventListener('click', (event) => {
    const btn = event.target.closest('.category-btn');
    if (!btn) return;

    document.querySelectorAll('.category-btn').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');

    state.category = btn.dataset.category;
    state.query = '';
    el.searchInput.value = '';

    loadNews({ reset: true });
  });
}

function bindSearch() {
  el.searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    state.query = el.searchInput.value.trim();
    loadNews({ reset: true });
  });
}

function bindChatbot() {
  const setOpen = (open) => {
    el.chatbotPanel.hidden = !open;
    el.chatbotToggle.setAttribute('aria-expanded', String(open));
    if (open) el.chatbotInput.focus();
  };

  el.chatbotToggle.addEventListener('click', () => setOpen(el.chatbotPanel.hidden));
  el.chatbotClose.addEventListener('click', () => setOpen(false));

  if (el.chatbotClear) {
    el.chatbotClear.addEventListener('click', () => {
      state.chatHistory = [];
      el.chatbotMessages.innerHTML = '';
      addChatMessage('Conversa reiniciada. Sobre o que você quer saber?', 'bot');
      renderChatSuggestions();
    });
  }

  renderChatSuggestions();

  el.chatbotForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const message = el.chatbotInput.value.trim();
    if (!message) return;
    sendChatMessage(message);
  });
}

function renderChatSuggestions() {
  if (!el.chatbotSuggestions) return;
  el.chatbotSuggestions.hidden = false;
  el.chatbotSuggestions.innerHTML = '';
  CHAT_SUGGESTIONS.forEach((text) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chatbot-suggestion';
    chip.textContent = text;
    chip.addEventListener('click', () => sendChatMessage(text));
    el.chatbotSuggestions.appendChild(chip);
  });
}

async function sendChatMessage(message) {
  el.chatbotInput.value = '';
  addChatMessage(message, 'user');
  if (el.chatbotSuggestions) el.chatbotSuggestions.hidden = true;

  const submitBtn = el.chatbotForm.querySelector('button');
  submitBtn.disabled = true;
  const typing = addTypingIndicator();

  try {
    const response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history: state.chatHistory.slice(-8) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível responder.');

    typing.remove();
    addChatMessage(data.answer, 'bot', data.provider);
    state.chatHistory.push({ role: 'user', content: message });
    state.chatHistory.push({ role: 'assistant', content: data.answer });
  } catch (error) {
    typing.remove();
    addChatMessage('Não foi possível responder agora. Tente novamente.', 'bot');
    console.error('Falha no chatbot:', error);
  } finally {
    submitBtn.disabled = false;
    el.chatbotInput.focus();
  }
}

function addChatMessage(text, type, provider) {
  const message = document.createElement('p');
  message.className = `chatbot-message chatbot-message-${type}`;
  if (type === 'bot' && provider === 'local') {
    message.classList.add('chatbot-message-local');
  }
  message.textContent = text;
  el.chatbotMessages.appendChild(message);
  el.chatbotMessages.scrollTop = el.chatbotMessages.scrollHeight;
  return message;
}

function addTypingIndicator() {
  const wrap = document.createElement('p');
  wrap.className = 'chatbot-message chatbot-message-bot chatbot-typing';
  wrap.setAttribute('aria-label', 'Assistente está digitando');
  wrap.innerHTML = '<span></span><span></span><span></span>';
  el.chatbotMessages.appendChild(wrap);
  el.chatbotMessages.scrollTop = el.chatbotMessages.scrollHeight;
  return wrap;
}

async function loadNews({ reset = false } = {}) {
  if (state.loading) {
    if (reset) state.pendingReset = true;
    return;
  }
  state.loading = true;

  if (reset) {
    state.page = 1;
    state.articles = [];
    renderSkeletons();
    el.featuredContent.hidden = true;
  }

  el.feedError.hidden = true;
  el.feedEmpty.hidden = true;
  el.loadMoreBtn.hidden = true;
  el.loadMoreBtn.textContent = 'Carregar mais notícias';

  const params = new URLSearchParams({
    category: state.category,
    page: state.page,
  });
  if (state.query) params.set('q', state.query);

  try {
    const response = await fetch(`${API_BASE_URL}/api/news?${params.toString()}`);

    if (!response.ok) {
      throw new Error(`Erro do servidor (status ${response.status})`);
    }

    const data = await response.json();
    const articles = (data.articles || []).sort(
      (left, right) => Number(Boolean(right.image)) - Number(Boolean(left.image))
    );

    state.articles = state.page === 1 ? articles : [...state.articles, ...articles];

    if (state.page === 1) {
      renderFeatured(articles[0] || null);
      renderNewsGrid(articles.slice(1));
    } else {
      renderNewsGrid(articles, { append: true });
    }

    el.feedCount.textContent = state.articles.length
      ? `${state.articles.length} notícia(s) carregada(s)`
      : '';

    if (!state.articles.length) {
      el.feedEmpty.hidden = false;
    }

    el.loadMoreBtn.hidden = !data.has_more;
  } catch (err) {
    console.error('Falha ao carregar notícias:', err);
    el.feedError.hidden = false;
    el.feedErrorText.textContent =
      'Não foi possível carregar as notícias agora. Verifique se o servidor Python (app.py) está rodando em ' +
      API_BASE_URL + '.';
  } finally {
    state.loading = false;
    if (state.pendingReset) {
      state.pendingReset = false;
      loadNews({ reset: true });
    }
  }
}

el.feedRetryBtn.addEventListener('click', () => loadNews({ reset: true }));

el.loadMoreBtn.addEventListener('click', () => {
  state.page += 1;
  loadNews({ reset: false });
});

function renderFeatured(article) {
  if (!article) {
    el.featuredContent.hidden = true;
    return;
  }

  const fragment = el.featuredTemplate.content.cloneNode(true);

  const img = fragment.querySelector('.featured-image');
  if (article.image) {
    img.src = imageUrl(article.image, article.category);
    img.alt = article.title || 'Imagem da notícia';
  } else {
    img.remove();
    fragment.querySelector('.featured-image-wrap').classList.add('no-image');
  }

  fragment.querySelector('.featured-title').textContent = article.title || 'Sem título';
  fragment.querySelector('.featured-summary').textContent =
    article.description || 'Descrição indisponível para esta notícia.';
  fragment.querySelector('.featured-source').textContent = article.source || 'Fonte desconhecida';
  fragment.querySelector('.featured-time').textContent = formatRelativeTime(article.published_at);

  const link = fragment.querySelector('.featured-link');
  link.href = article.url || '#';

  el.featuredContent.innerHTML = '';
  el.featuredContent.appendChild(fragment);
  el.featuredContent.hidden = false;
}

function renderNewsGrid(articles, { append = false } = {}) {
  if (!append) {
    el.newsGrid.innerHTML = '';
  }

  const startIndex = append ? el.newsGrid.children.length : 0;
  articles.forEach((article, i) => appendCard(article, startIndex + i));
}

function appendCard(article, index) {
  const fragment = el.newsCardTemplate.content.cloneNode(true);
  const card = fragment.querySelector('.news-card');

  card.dataset.category = article.category || state.category;
  card.style.setProperty('--stagger-index', index % 12);

  const img = fragment.querySelector('.news-card-image');
  const imageWrap = fragment.querySelector('.news-card-image-wrap');
  if (article.image) {
    img.src = imageUrl(article.image, article.category);
    img.alt = article.title || 'Imagem da notícia';
    img.addEventListener('error', () => {
      img.remove();
      imageWrap.classList.add('no-image');
    }, { once: true });
  } else {
    img.remove();
    imageWrap.classList.add('no-image');
  }

  fragment.querySelector('.news-card-category').textContent =
    CATEGORY_LABELS[article.category] || CATEGORY_LABELS[state.category] || 'Notícia';

  fragment.querySelector('.news-card-title').textContent = article.title || 'Sem título';
  fragment.querySelector('.news-card-summary').textContent = article.description || '';

  fragment.querySelector('.news-card-source').textContent = article.source || 'Fonte desconhecida';
  fragment.querySelector('.news-card-time').textContent = formatRelativeTime(article.published_at);

  const link = fragment.querySelector('.news-card-link');
  link.href = article.url || '#';

  el.newsGrid.appendChild(fragment);
}

function placeholderImage() {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="250">
       <rect width="100%" height="100%" fill="#e9e8e1"/>
       <text x="50%" y="50%" font-family="sans-serif" font-size="16" fill="#6b7080"
             text-anchor="middle" dominant-baseline="middle">Imagem não disponível</text>
     </svg>`
  );
}

function imageUrl(url, category) {
  if (!url) return placeholderImage();
  if (url.startsWith('data:') || url.startsWith(`${API_BASE_URL}/api/image`)) return url;
  return `${API_BASE_URL}/api/image?url=${encodeURIComponent(url)}`;
}

function formatRelativeTime(isoString) {
  if (!isoString) return '';
  const published = new Date(isoString);
  const now = new Date();
  const diffMinutes = Math.round((now - published) / 60000);

  if (diffMinutes < 1) return 'agora mesmo';
  if (diffMinutes < 60) return `há ${diffMinutes} min`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `há ${diffHours} h`;

  const diffDays = Math.round(diffHours / 24);
  return `há ${diffDays} d`;
}


/* =========================================================================
   NEWSLETTER
   ========================================================================= */
function bindNewsletter() {
  if (!el.newsletterForm) return;

  el.newsletterForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = el.newsletterEmail.value.trim();
    if (!email) return;

    const button = el.newsletterForm.querySelector('button');
    button.disabled = true;
    setNewsletterFeedback('Enviando...', null);

    try {
      const response = await fetch(`${API_BASE_URL}/api/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível cadastrar seu e-mail.');

      setNewsletterFeedback(data.message || 'Cadastro feito com sucesso!', 'success');
      el.newsletterForm.reset();
    } catch (error) {
      setNewsletterFeedback(error.message, 'error');
      console.error('Falha ao cadastrar na newsletter:', error);
    } finally {
      button.disabled = false;
    }
  });
}

function setNewsletterFeedback(text, kind) {
  if (!el.newsletterFeedback) return;
  el.newsletterFeedback.textContent = text;
  el.newsletterFeedback.hidden = false;
  el.newsletterFeedback.classList.toggle('is-success', kind === 'success');
  el.newsletterFeedback.classList.toggle('is-error', kind === 'error');
}


/* =========================================================================
   MURAL DOS LEITORES (COMENTÁRIOS)
   ========================================================================= */
function bindReaderBoard() {
  if (!el.readerBoardForm) return;

  el.readerBoardForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = el.readerBoardName.value.trim();
    const text = el.readerBoardText.value.trim();
    if (!text) return;

    const button = el.readerBoardForm.querySelector('button');
    button.disabled = true;

    try {
      const response = await fetch(`${API_BASE_URL}/api/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, text }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Não foi possível publicar seu comentário.');

      appendComment(data.comment);
      el.readerBoardText.value = '';
    } catch (error) {
      console.error('Falha ao comentar:', error);
      window.alert(error.message || 'Não foi possível publicar seu comentário agora.');
    } finally {
      button.disabled = false;
    }
  });
}

async function loadComments() {
  if (!el.readerBoardList) return;

  if (el.readerBoardDate) {
    const formatted = new Date().toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: 'long',
    });
    el.readerBoardDate.textContent = formatted;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/comments`);
    if (!response.ok) throw new Error('Não foi possível carregar os comentários.');
    const data = await response.json();
    el.readerBoardList.innerHTML = '';
    (data.comments || []).forEach(appendComment);
    updateReaderBoardEmptyState();
  } catch (error) {
    console.error('Falha ao carregar o mural:', error);
    updateReaderBoardEmptyState();
  }
}

function appendComment(comment) {
  if (!comment || !el.readerBoardList) return;

  const item = document.createElement('li');
  item.className = 'reader-board-comment';

  const head = document.createElement('div');
  head.className = 'reader-board-comment-head';

  const name = document.createElement('span');
  name.className = 'reader-board-comment-name';
  name.textContent = comment.name || 'Leitor anônimo';

  const time = document.createElement('span');
  time.textContent = formatRelativeTime(comment.time);

  head.appendChild(name);
  head.appendChild(time);

  const text = document.createElement('p');
  text.className = 'reader-board-comment-text';
  text.textContent = comment.text || '';

  item.appendChild(head);
  item.appendChild(text);
  el.readerBoardList.appendChild(item);

  updateReaderBoardEmptyState();
}

function updateReaderBoardEmptyState() {
  if (!el.readerBoardEmpty || !el.readerBoardList) return;
  el.readerBoardEmpty.hidden = el.readerBoardList.children.length > 0;
}
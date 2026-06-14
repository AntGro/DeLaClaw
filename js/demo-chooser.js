// ===================================================================
// DEMO CHOOSER — lets users pick generic or personalised demo data
// ===================================================================
import { t, getLang } from './i18n.js';
import { lucideIcon } from './icons.js';

// ── Prompt generators (EN / FR / ES) ──────────────────────────────

function buildPrompt(lang) {
  const today = new Date().toISOString().slice(0, 10);
  const schema = `{
  "projects": [
    { "name": "Project Name", "shortname": "PRJ", "color": "#hex" }
  ],
  "tasks": [
    { "project": "Project Name", "text": "Task description", "status": "todo|review|approved" }
  ],
  "todos": [
    { "text": "To-do item", "priority": "urgent|high|medium|low|normal", "category": "Category", "due_date": "YYYY-MM-DD or null" }
  ],
  "habits": [
    { "name": "Habit name", "frequency_rule": "see below", "category": "Category" }
  ],
  "flashcards": [
    { "deck": "Deck Name", "front": "Question", "back": "Answer" }
  ],
  "birthdays": [
    { "name": "Person Name", "birthday": "YYYY-MM-DD", "note": "optional" }
  ],
  "vestiaire": [
    { "name": "Item name", "category": "Outerwear|Tops|Bottoms|Shoes|Accessories", "color": "Color", "brand": "Brand", "size": "Size" }
  ],
  "lists": [
    { "name": "List Name", "color": "#hex" }
  ],
  "list_items": [
    { "list_name": "List Name", "text": "Item text" }
  ]
}`;

  const freqRules = `Frequency rules for habits (pick the best fit):
  "daily", "weekly:Mon,Fri", "every_N_weeks:2:Sat", "monthly:15", "every_N_months:3:1", "every_N_months:6:28", "yearly:04-01"`;

  const prompts = {
    en: `I'm trying out DeLaClaw, a personal life-management app (https://github.com/AntGro/DeLaClaw). Generate personalised demo data so I can see the app with content relevant to my life.

**Personalise for me.** Use what you know about me — age, gender, location, profession, education, hobbies, interests — to shape the content. If you don't know something, make a reasonable assumption that feels coherent (e.g. pick a city, a profession, a few hobbies) and generate data that fits that persona.

Generate 3–5 items per category. Use today (${today}) as reference for dates. IDs and timestamps are auto-generated — don't include them. For tasks, set "project" to the project's name. For list_items, set "list_name" to the list's name.

**Habits & chores.** Habits aren't just personal development — include household chores, especially infrequent ones where a reminder is essential (e.g. descaling the washing machine every 3 months, changing pillowcases every 2 weeks, cleaning windows every 4 months, vacuuming behind furniture monthly).
${freqRules}

**Flashcards.** Generate smart, educational flashcards tailored to my interests or knowledge areas. Each card: one precise question → one concise factual answer (1–2 sentences). Avoid trivially obvious questions. Vary the decks (e.g. general knowledge, vocabulary, history, science, professional topics). For non-English terms or cultural topics, keep question and answer in the relevant language.

Respond ONLY with valid JSON — no markdown fences, no commentary.

${schema}`,

    fr: `J'essaie DeLaClaw, une application de gestion de vie personnelle (https://github.com/AntGro/DeLaClaw). Génère des données de démo personnalisées pour que je puisse voir l'application avec du contenu pertinent pour ma vie.

**Personnalise pour moi.** Utilise ce que tu sais sur moi — âge, genre, ville, métier, formation, loisirs, centres d'intérêt — pour façonner le contenu. Si tu ne sais pas, fais une hypothèse cohérente (choisis une ville, un métier, quelques hobbies) et génère des données qui collent à ce profil.

Génère 3 à 5 éléments par catégorie. Utilise la date du jour (${today}) comme référence. Les IDs et timestamps sont auto-générés — ne les inclus pas. Pour les tâches, mets le nom du projet dans "project". Pour les list_items, mets le nom de la liste dans "list_name".

**Habitudes & tâches ménagères.** Les habitudes ne sont pas que du développement personnel — inclus des corvées ménagères, surtout les peu fréquentes où un rappel est indispensable (ex. détartrer le lave-linge tous les 3 mois, changer les taies d'oreiller toutes les 2 semaines, nettoyer les vitres tous les 4 mois, aspirer derrière les meubles tous les mois).
${freqRules}

**Flashcards.** Génère des flashcards éducatives et adaptées à mes centres d'intérêt. Chaque carte : une question précise → une réponse factuelle concise (1–2 phrases). Évite les questions triviales. Varie les decks (culture générale, vocabulaire, histoire, sciences, sujets professionnels). Pour les termes ou sujets culturels français, garde question et réponse en français.

Réponds UNIQUEMENT avec du JSON valide — pas de blocs markdown, pas de commentaire.

${schema}`,

    es: `Estoy probando DeLaClaw, una app de gestión de vida personal (https://github.com/AntGro/DeLaClaw). Genera datos de demo personalizados para que pueda ver la app con contenido relevante para mi vida.

**Personaliza para mí.** Usa lo que sepas sobre mí — edad, género, ciudad, profesión, formación, hobbies, intereses — para dar forma al contenido. Si no lo sabes, haz una suposición coherente (elige una ciudad, una profesión, algunos hobbies) y genera datos que encajen con ese perfil.

Genera 3–5 elementos por categoría. Usa la fecha de hoy (${today}) como referencia. Los IDs y timestamps se generan automáticamente — no los incluyas. Para las tareas, pon el nombre del proyecto en "project". Para list_items, pon el nombre de la lista en "list_name".

**Hábitos y tareas del hogar.** Los hábitos no son solo desarrollo personal — incluye tareas domésticas, especialmente las poco frecuentes donde un recordatorio es esencial (ej. descalcificar la lavadora cada 3 meses, cambiar fundas de almohada cada 2 semanas, limpiar ventanas cada 4 meses, aspirar detrás de los muebles mensualmente).
${freqRules}

**Flashcards.** Genera flashcards educativas adaptadas a mis intereses o áreas de conocimiento. Cada tarjeta: una pregunta precisa → una respuesta factual concisa (1–2 frases). Evita preguntas triviales. Varía los mazos (cultura general, vocabulario, historia, ciencia, temas profesionales). Para términos o temas culturales en español, mantén pregunta y respuesta en español.

Responde SOLO con JSON válido — sin bloques markdown, sin comentarios.

${schema}`,
  };

  return prompts[lang] || prompts.en;
}

// ── JSON parsing (lenient) ────────────────────────────────────────

function parseCustomJSON(raw) {
  let cleaned = raw.trim();
  // Strip markdown code fences
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```\s*$/i, '');
  cleaned = cleaned.trim();
  const data = JSON.parse(cleaned);
  // Validate: must be an object with at least one recognised key
  const validKeys = ['projects', 'tasks', 'todos', 'habits', 'flashcards', 'birthdays', 'vestiaire', 'lists', 'list_items'];
  const found = Object.keys(data).filter(k => validKeys.includes(k));
  if (found.length === 0) throw new Error('No recognised data tables found');
  return data;
}

// ── Normalise custom LLM data (fill missing fields) ─────────────

function normalizeCustomData(data) {
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  let seq = 0;
  const gid = (prefix) => `custom-${prefix}-${String(++seq).padStart(3, '0')}`;

  function base(row, prefix, idx) {
    if (!row.id) row.id = gid(prefix);
    if (!row.created_at) row.created_at = now;
    if (!row.updated_at) row.updated_at = now;
    if (row.sort_order == null) row.sort_order = idx;
    return row;
  }

  // Build project name → ID map
  const projNameToId = {};
  if (data.projects) {
    data.projects = data.projects.map((r, i) => {
      base(r, 'proj', i);
      if (r.archived == null) r.archived = false;
      if (!r.links) r.links = [];
      if (!r.tech) r.tech = '';
      if (!r.shortname) r.shortname = r.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
      if (!r.color) r.color = '#6366f1';
      projNameToId[r.name] = r.id;
      return r;
    });
  }

  // Resolve task project references (name → ID)
  if (data.tasks) {
    data.tasks = data.tasks.map((r, i) => {
      base(r, 'task', i);
      if (!r.status) r.status = 'todo';
      if (r.project && projNameToId[r.project]) {
        r.project = projNameToId[r.project];
      }
      return r;
    });
  }

  if (data.todos) {
    data.todos = data.todos.map((r, i) => {
      base(r, 'todo', i);
      if (r.done == null) r.done = false;
      if (!r.priority) r.priority = 'normal';
      if (!r.category) r.category = 'General';
      return r;
    });
  }

  if (data.habits) {
    data.habits = data.habits.map((r, i) => {
      base(r, 'habit', i);
      if (r.is_draft == null) r.is_draft = false;
      if (!r.next_due) r.next_due = today + 'T00:00:00+00:00';
      if (!r.category) r.category = 'General';
      if (!r.frequency_rule) r.frequency_rule = 'daily';
      return r;
    });
  }

  if (data.flashcards) {
    data.flashcards = data.flashcards.map((r, i) => {
      base(r, 'fc', i);
      if (!r.status) r.status = 'new';
      if (!r.deck) r.deck = 'General';
      if (r.next_review === undefined) r.next_review = null;
      return r;
    });
  }

  if (data.birthdays) {
    data.birthdays = data.birthdays.map((r, i) => {
      base(r, 'bd', i);
      if (r.note == null) r.note = '';
      if (r.avatar_url === undefined) r.avatar_url = null;
      return r;
    });
  }

  if (data.vestiaire) {
    data.vestiaire = data.vestiaire.map((r, i) => {
      base(r, 'vest', i);
      if (r.note == null) r.note = '';
      if (r.purchase_status === undefined) r.purchase_status = null;
      if (r.image_url === undefined) r.image_url = null;
      return r;
    });
  }

  // Build list name → ID map
  const listNameToId = {};
  if (data.lists) {
    data.lists = data.lists.map((r, i) => {
      base(r, 'list', i);
      if (!r.icon) r.icon = 'list';
      if (r.archived == null) r.archived = 0;
      if (!r.color) r.color = '#6366f1';
      listNameToId[r.name] = r.id;
      return r;
    });
  }

  if (data.list_items) {
    data.list_items = data.list_items.map((r, i) => {
      base(r, 'li', i);
      if (r.checked == null) r.checked = 0;
      // Resolve list_name → list_id
      if (r.list_name && !r.list_id) {
        r.list_id = listNameToId[r.list_name] || null;
        delete r.list_name;
      }
      // Also resolve list_id if it matches a list name
      if (r.list_id && listNameToId[r.list_id]) {
        r.list_id = listNameToId[r.list_id];
      }
      return r;
    });
  }

  return data;
}

// ── LLM service buttons ──────────────────────────────────────────

const LLM_SERVICES = [
  {
    name: 'ChatGPT',
    url: 'https://chatgpt.com',
    appUrl: 'https://chatgpt.com',
    svg: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#10a37f"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071.005l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071-.006l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.66zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>',
  },
  {
    name: 'Claude',
    url: 'https://claude.ai/new',
    appUrl: 'https://claude.ai/new',
    svg: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#da7756"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
  },
  {
    name: 'Mistral',
    url: 'https://chat.mistral.ai/chat',
    appUrl: 'https://chat.mistral.ai/chat',
    svg: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#FF7000"><path d="M17.143 3.429v3.428h-3.429v3.429h-3.428V6.857H6.857V3.43H3.43v13.714H0v3.428h10.286v-3.428H6.857v-3.429h3.429v3.429h3.429v-3.429h3.428v3.429h-3.428v3.428H24v-3.428h-3.43V3.429z"/></svg>',
  },
  {
    name: 'Meta AI',
    url: 'https://www.meta.ai',
    appUrl: 'https://www.meta.ai',
    svg: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#0668E1"><path d="M6.915 4.03c-1.968 0-3.683 1.28-4.871 3.113C.704 9.208 0 11.883 0 14.449c0 .706.07 1.369.21 1.973a6.624 6.624 0 0 0 .265.86 5.297 5.297 0 0 0 .371.761c.696 1.159 1.818 1.927 3.593 1.927 1.497 0 2.633-.671 3.965-2.444.76-1.012 1.144-1.626 2.663-4.32l.756-1.339.186-.325c.061.1.121.196.183.3l2.152 3.595c.724 1.21 1.665 2.556 2.47 3.314 1.046.987 1.992 1.22 3.06 1.22 1.075 0 1.876-.355 2.455-.843a3.743 3.743 0 0 0 .81-.973c.542-.939.861-2.127.861-3.745 0-2.72-.681-5.357-2.084-7.45-1.282-1.912-2.957-2.93-4.716-2.93-1.047 0-2.088.467-3.053 1.308-.652.57-1.257 1.29-1.82 2.05-.69-.875-1.335-1.547-1.958-2.056-1.182-.966-2.315-1.303-3.454-1.303zm10.16 2.053c1.147 0 2.188.758 2.992 1.999 1.132 1.748 1.647 4.195 1.647 6.4 0 1.548-.368 2.9-1.839 2.9-.58 0-1.027-.23-1.664-1.004-.496-.601-1.343-1.878-2.832-4.358l-.617-1.028a44.908 44.908 0 0 0-1.255-1.98c.07-.109.141-.224.211-.327 1.12-1.667 2.118-2.602 3.358-2.602zm-10.201.553c1.265 0 2.058.791 2.675 1.446.307.327.737.871 1.234 1.579l-1.02 1.566c-.757 1.163-1.882 3.017-2.837 4.338-1.191 1.649-1.81 1.817-2.486 1.817-.524 0-1.038-.237-1.383-.794-.263-.426-.464-1.13-.464-2.046 0-2.221.63-4.535 1.66-6.088.454-.687.964-1.226 1.533-1.533a2.264 2.264 0 0 1 1.088-.285z"/></svg>',
  },
];

// ── Escape helper (avoids HTML entity literals in source) ─────────

function escHtml(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

// ── Hydrate data-icon spans within a root element ────────────────

function hydrateIconsIn(root) {
  root.querySelectorAll('[data-icon]').forEach(span => {
    const name = span.dataset.icon;
    const size = parseInt(span.dataset.size || '16');
    span.outerHTML = lucideIcon(name, size);
  });
}

// ── Main export ──────────────────────────────────────────────────

/**
 * Shows a modal letting the user choose between generic demo data
 * or personalised data via LLM prompt.
 * Returns a Promise that resolves with:
 *   { type: 'generic' }  or  { type: 'custom', data: {...} }
 */
export function showDemoChooser(lang) {
  return new Promise((resolve) => {
    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay visible';
    overlay.id = 'demoChooserOverlay';

    const prompt = buildPrompt(lang);
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    const serviceButtons = LLM_SERVICES.map(s => {
      const href = isMobile && s.appUrl ? s.appUrl : s.url;
      return `<a href="${href}" target="_blank" rel="noopener" class="dc-llm-btn">${s.svg}<span>${s.name}</span></a>`;
    }).join('');

    overlay.innerHTML = `
      <div class="dc-container">
        <div class="dc-header">
          <h2>${t('demo_chooser.title')}</h2>
          <p class="dc-subtitle">${t('demo_chooser.subtitle')}</p>
        </div>

        <div class="dc-options" id="dcOptions">
          <button class="dc-card dc-card-recommended" id="dcCustomCard">
            <span class="dc-badge">${t('demo_chooser.recommended')}</span>
            <div class="dc-card-icon">${lucideIcon('sparkles', 28)}</div>
            <div class="dc-card-title">${t('demo_chooser.custom_title')}</div>
            <div class="dc-card-desc">${t('demo_chooser.custom_desc')}</div>
          </button>
          <button class="dc-card" id="dcGenericCard">
            <div class="dc-card-icon">${lucideIcon('list', 28)}</div>
            <div class="dc-card-title">${t('demo_chooser.generic_title')}</div>
            <div class="dc-card-desc">${t('demo_chooser.generic_desc')}</div>
          </button>
        </div>

        <div class="dc-custom-flow" id="dcCustomFlow" style="display:none">
          <div class="dc-step">
            <div class="dc-step-header">
              <span class="dc-step-num">1</span>
              <span>${t('demo_chooser.step1_title')}</span>
            </div>
            <div class="dc-prompt-box">
              <pre class="dc-prompt-text" id="dcPromptText"></pre>
              <button class="dc-copy-btn" id="dcCopyBtn">
                <span class="dc-copy-icon">${lucideIcon('copy', 15)}</span>
                <span id="dcCopyLabel">${t('demo_chooser.copy')}</span>
              </button>
            </div>
          </div>

          <div class="dc-step">
            <div class="dc-step-header">
              <span class="dc-step-num">2</span>
              <span>${t('demo_chooser.step2_title')}</span>
            </div>
            <div class="dc-llm-links">${serviceButtons}</div>
          </div>

          <div class="dc-step">
            <div class="dc-step-header">
              <span class="dc-step-num">3</span>
              <span>${t('demo_chooser.step3_title')}</span>
            </div>
            <textarea class="dc-paste-area" id="dcPasteArea" rows="8" placeholder="${escHtml(t('demo_chooser.paste_placeholder'))}"></textarea>
            <div class="dc-error" id="dcError" style="display:none"></div>
            <div class="dc-flow-actions">
              <button class="dc-btn-secondary" id="dcBackBtn">${t('demo_chooser.back')}</button>
              <button class="dc-btn-primary" id="dcLoadBtn" disabled>
                ${lucideIcon('check', 15)}
                ${t('demo_chooser.load')}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Set prompt text via textContent to avoid entity issues
    const promptPre = overlay.querySelector('#dcPromptText');
    promptPre.textContent = prompt;

    document.body.appendChild(overlay);

    // ── Wire up events ──

    const genericCard = overlay.querySelector('#dcGenericCard');
    const customCard = overlay.querySelector('#dcCustomCard');
    const optionsDiv = overlay.querySelector('#dcOptions');
    const customFlow = overlay.querySelector('#dcCustomFlow');
    const copyBtn = overlay.querySelector('#dcCopyBtn');
    const copyLabel = overlay.querySelector('#dcCopyLabel');
    const copyIcon = overlay.querySelector('.dc-copy-icon');
    const pasteArea = overlay.querySelector('#dcPasteArea');
    const loadBtn = overlay.querySelector('#dcLoadBtn');
    const backBtn = overlay.querySelector('#dcBackBtn');
    const errorDiv = overlay.querySelector('#dcError');

    function cleanup() {
      overlay.remove();
    }

    // Dismiss modal by clicking outside the container
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve({ type: 'cancelled' });
      }
    });

    genericCard.addEventListener('click', () => {
      cleanup();
      resolve({ type: 'generic' });
    });

    customCard.addEventListener('click', () => {
      optionsDiv.style.display = 'none';
      customFlow.style.display = 'block';
      const subtitle = overlay.querySelector('.dc-subtitle');
      if (subtitle) subtitle.style.display = 'none';
    });

    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(prompt);
        copyLabel.textContent = t('common.copied');
        copyIcon.innerHTML = lucideIcon('clipboard-check', 15);
        setTimeout(() => {
          copyLabel.textContent = t('demo_chooser.copy');
          copyIcon.innerHTML = lucideIcon('copy', 15);
        }, 2000);
      } catch {
        // Fallback: select text
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(promptPre);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    });

    pasteArea.addEventListener('input', () => {
      loadBtn.disabled = !pasteArea.value.trim();
      errorDiv.style.display = 'none';
    });

    backBtn.addEventListener('click', () => {
      customFlow.style.display = 'none';
      optionsDiv.style.display = '';
      const subtitle = overlay.querySelector('.dc-subtitle');
      if (subtitle) subtitle.style.display = '';
      errorDiv.style.display = 'none';
      pasteArea.value = '';
      loadBtn.disabled = true;
    });

    loadBtn.addEventListener('click', () => {
      try {
        const data = parseCustomJSON(pasteArea.value);
        normalizeCustomData(data);
        cleanup();
        resolve({ type: 'custom', data });
      } catch (e) {
        errorDiv.textContent = t('demo_chooser.parse_error') + ' ' + e.message;
        errorDiv.style.display = 'block';
      }
    });
  });
}

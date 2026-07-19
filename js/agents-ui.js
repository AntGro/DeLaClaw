// ===================================================================
// AGENTS UI — Settings > Agents pane
// Multi-token personal API for external agents (Claude Code, Codex…)
// Uses token_hash storage; raw token shown once via create_agent_grant RPC.
// Falls back to local SHA-256 generation for Local/Drive adapters.
// ===================================================================
import state from './state.js';
import db from './db.js';
import { t } from './i18n.js';
import { esc, showToast, showDeleteConfirm } from './utils.js';
import { lucideIcon } from './icons.js';

let _lastCreatedToken = null;

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fmtDate(s) {
  if (!s) return '';
  try { return new Date(s).toLocaleString(); } catch { return s; }
}

async function fetchGrants() {
  try {
    // Try RLS filtered table
    const { data, error } = await db.from('agent_grants').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  } catch (e) {
    // Fallback: try without order for adapters that don't support order syntax
    try {
      const { data } = await db.from('agent_grants').select('*');
      if (data) return data.sort((a,b) => new Date(b.created_at||0)-new Date(a.created_at||0));
    } catch {}
    console.warn('fetchGrants failed', e);
    return [];
  }
}

export async function renderAgentsPane() {
  const container = document.getElementById('agentsPaneContent');
  if (!container) return;
  const activeMode = localStorage.getItem('claw_cc_active_mode');

  if (activeMode === 'demo') {
    container.innerHTML = `<p class="setting-hint">${t('agents.no_tokens_hint')} Demo mode does not support agent tokens.</p>`;
    return;
  }

  let grants = await fetchGrants();
  // Filter revoked visually? Keep them but faded
  const activeGrants = grants.filter(g => !g.revoked_at);
  const revokedGrants = grants.filter(g => g.revoked_at);

  const tokenBlock = _lastCreatedToken ? `
    <div class="sharing-group-card" style="border-color:var(--accent);background:color-mix(in srgb,var(--accent) 6%, var(--surface))">
      <div class="setting-group-label" style="color:var(--accent)">${lucideIcon('key',14)} ${esc(t('agents.token_created'))}</div>
      <p class="setting-hint" style="margin:6px 0 8px">${esc(t('agents.token_copy_once'))}</p>
      <div class="sharing-invite-link-box">
        <input type="text" id="agentsLastToken" value="${esc(_lastCreatedToken.token)}" readonly style="font-family:monospace">
        <button class="sharing-invite-btn" data-action="agents-copy-last-token">${lucideIcon('copy',14)} ${esc(t('agents.copy'))}</button>
      </div>
      <p class="setting-hint" style="margin-top:8px;font-size:0.78rem">${esc(_lastCreatedToken.display_name)} • ${esc(t('agents.scope_full'))}</p>
    </div>` : '';

  const createRow = `
    <div class="setting-group">
      <div class="setting-group-label">${esc(t('agents.create'))}</div>
      <p class="setting-hint">${esc(t('agents.create_hint'))}</p>
      <div class="sharing-invite-row" style="margin-top:8px">
        <input type="text" class="sharing-invite-input" id="agentsNewName" placeholder="${esc(t('agents.name_placeholder'))}" maxlength="80">
        <button class="sharing-invite-btn" data-action="agents-create" id="agentsCreateBtn">${lucideIcon('plus',14)} ${esc(t('agents.create'))}</button>
      </div>
      <p class="setting-hint" style="margin-top:8px;font-size:0.78rem;opacity:0.8">${t('agents.security_hint')}</p>
    </div>`;

  let listHtml = '';
  if (!grants.length) {
    listHtml = `<div class="setting-group"><p class="setting-hint"><strong>${esc(t('agents.no_tokens'))}</strong><br>${esc(t('agents.no_tokens_hint'))}</p></div>`;
  } else {
    const rowFor = (g) => {
      const revoked = !!g.revoked_at;
      const lastUsed = g.last_used_at ? `${esc(t('agents.last_used'))}: ${esc(fmtDate(g.last_used_at))}` : esc(t('agents.never_used'));
      const created = g.created_at ? `${esc(t('agents.created_at'))}: ${esc(fmtDate(g.created_at))}` : '';
      return `<div class="sharing-group-card" style="${revoked ? 'opacity:0.55' : ''}">
        <div class="sharing-group-header">
          <div class="sharing-group-info">
            <h4>${esc(g.display_name)} ${revoked ? `<span style="font-weight:400;font-size:0.75em;color:var(--muted)">(${esc(t('agents.revoke'))})</span>` : ''}</h4>
            <span class="sharing-group-stats">${esc(created)} · ${esc(lastUsed)} · ${esc(t('agents.scope_full'))}</span>
          </div>
          <div class="sharing-group-actions">
            ${!revoked ? `<button class="sharing-action-btn sharing-leave-btn" data-action="agents-revoke" data-id="${esc(g.id)}" title="${esc(t('agents.revoke'))}">${lucideIcon('trash-2',14)} ${esc(t('agents.revoke'))}</button>` : ''}
          </div>
        </div>
        <div style="font-family:monospace;font-size:0.72rem;color:var(--muted);word-break:break-all">id: ${esc(g.id)}<br>hash: ${esc((g.token_hash||'').slice(0,16))}…</div>
      </div>`;
    };
    listHtml = `<div class="setting-group"><div class="setting-group-label">${esc(t('agents.title'))} (${activeGrants.length})</div>`;
    for (const g of activeGrants) listHtml += rowFor(g);
    if (revokedGrants.length) {
      listHtml += `<div class="setting-group-label" style="margin-top:14px;opacity:0.7">Revoked (${revokedGrants.length})</div>`;
      for (const g of revokedGrants) listHtml += rowFor(g);
    }
    listHtml += `</div>`;
  }

  const howTo = `
    <div class="setting-group" style="margin-top:16px">
      <div class="setting-group-label">${esc(t('agents.how_to_use'))}</div>
      <p class="setting-hint">${t('agents.how_to_use_body')}</p>
      <p class="setting-hint" style="margin-top:6px;font-family:monospace;font-size:0.78rem;background:var(--surface2);padding:8px;border-radius:8px">X-Agent-Token: YOUR_TOKEN<br>apikey: ANON_KEY<br>Authorization: Bearer ANON_KEY</p>
    </div>`;

  container.innerHTML = `<p class="setting-hint" style="margin-bottom:12px">${esc(t('agents.description'))}</p>${tokenBlock}${createRow}${listHtml}${howTo}`;

  // Wire enter key
  const input = document.getElementById('agentsNewName');
  if (input) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') agentsCreate(); });
    setTimeout(() => input.focus(), 30);
  }
}

async function agentsCreate() {
  const input = document.getElementById('agentsNewName');
  const btn = document.getElementById('agentsCreateBtn');
  const name = input?.value?.trim();
  if (!name) { showToast(t('agents.name_required'), 'error'); return; }
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }

  try {
    let result = null;
    // Try RPC first (Supabase)
    try {
      const { data, error } = await db.rpc('create_agent_grant', { p_display_name: name, p_scope: 'full' });
      if (error) throw error;
      // RPC returns table set (array)
      if (Array.isArray(data) && data.length) result = data[0];
      else if (data) result = data;
    } catch (e) {
      // Fallback local generation
      if (String(e.message||'').toLowerCase().includes('not found') || String(e.message||'').includes('does not exist') || true) {
        // generate raw token (64 hex chars = 32 bytes)
        const rawBytes = new Uint8Array(32);
        crypto.getRandomValues(rawBytes);
        const raw = Array.from(rawBytes).map(b=>b.toString(16).padStart(2,'0')).join('');
        const hash = await sha256Hex(raw);
        // Insert directly
        const rec = { display_name: name, token_hash: hash, scope: 'full' };
        // Supabase insert returns id if we have owner_id trigger; local insert auto sets owner_id
        const { data, error: insErr } = await db.from('agent_grants').insert(rec).select();
        if (insErr) throw insErr;
        const inserted = Array.isArray(data) ? data[0] : data;
        result = { id: inserted?.id || rec.display_name, token: raw, display_name: name, scope: 'full', created_at: new Date().toISOString() };
        // If RPC existed but we are here due to other error, we still have token
        if (!inserted && e && !String(e.message).includes('does not exist')) {
          // Still try to show token from fallback
        }
      }
    }

    if (!result || !result.token) {
      // For adapters where RPC succeeded but token field is named differently, try to extract
      // Last effort: if RPC didn't return token but we inserted via fallback, we already have it
      throw new Error('No token returned');
    }

    _lastCreatedToken = result;
    if (input) input.value = '';
    showToast(t('agents.token_created'), 'success');
    await renderAgentsPane();
  } catch (e) {
    console.warn('agentsCreate failed', e);
    showToast(e.message || 'Failed to create token', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

async function agentsRevoke(id) {
  showDeleteConfirm(
    t('agents.revoke'),
    t('agents.revoke_confirm'),
    async () => {
      try {
        // Try RPC
        try {
          const { error } = await db.rpc('revoke_agent_grant', { p_id: id });
          if (error) throw error;
        } catch {
          // Fallback direct update
          await db.from('agent_grants').update({ revoked_at: new Date().toISOString() }).eq('id', id);
        }
        _lastCreatedToken = null;
        showToast(t('agents.revoked'), 'info');
        await renderAgentsPane();
      } catch (e) {
        showToast(e.message, 'error');
      }
    }
  );
}

function agentsCopyLastToken() {
  const el = document.getElementById('agentsLastToken');
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(() => showToast(t('agents.copied'), 'success'));
}

export function applyAgentsI18n() {
  const titleEl = document.getElementById('settingsPaneAgentsTitle');
  if (titleEl) titleEl.textContent = t('agents.title');
  const navEl = document.getElementById('settingsNavAgents');
  if (navEl) navEl.textContent = t('agents.nav');
}

// Expose actions
window.agentsCreate = agentsCreate;
window.agentsRevoke = agentsRevoke;
window.agentsCopyLastToken = agentsCopyLastToken;

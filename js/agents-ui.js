// ===================================================================
// AGENTS UI — Settings > Agents pane
// Friendly copy-paste setup for external agents (Claude Code, Codex…)
// ===================================================================
import db from './db.js';
import { t } from './i18n.js';
import { esc, showToast, showDeleteConfirm } from './utils.js';
import { lucideIcon } from './icons.js';
import { STAY_CONNECTED_KEY } from './state.js';

let _lastCreatedToken = null;
let _lastCreatedPrompt = null;

async function sha256Hex(str) {
  const enc = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function fmtDate(s) { try { return new Date(s).toLocaleString(); } catch { return s||''; } }
function getStayCreds() {
  try { const raw = localStorage.getItem(STAY_CONNECTED_KEY); if (!raw) return {url:'',key:''}; const j=JSON.parse(raw); return {url:j.url||'',key:j.key||''}; } catch { return {url:'',key:''}; }
}
function buildAgentPrompt({ displayName, token, url, anonKey }) {
  const safeUrl = url || 'https://YOUR-PROJECT.supabase.co';
  const safeAnon = anonKey || 'YOUR-ANON-KEY';
  return `You have been granted access to my DeLaClaw personal database.

Agent: ${displayName}
Supabase Project URL: ${safeUrl}
Supabase Anon Key: ${safeAnon}
DeLaClaw Agent Token: ${token}

How to connect (for you, the AI agent):

1. Use Supabase REST API at ${safeUrl}/rest/v1/<table>
   Example: GET ${safeUrl}/rest/v1/tasks?select=*

2. Headers for EVERY request:
   apikey: ${safeAnon}
   Authorization: Bearer ${safeAnon}
   X-Agent-Token: ${token}

3. You have full read/write access scoped to my account (RLS is owner-or-agent). Tables: projects, tasks, todos, habits, habit_completions, birthdays, vestiaire, flashcards, flashcard_notes, lists, list_items, texts, prompts, settings, agent_grants.

4. Keep credentials secret. Never log the Agent Token or commit it. To confirm, SELECT tasks limit 1.`;
}

async function fetchGrants() {
  try {
    const { data, error } = await db.from('agent_grants').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    return data||[];
  } catch (e) {
    try { const { data } = await db.from('agent_grants').select('*'); if (data) return data.sort((a,b)=>new Date(b.created_at||0)-new Date(a.created_at||0)); } catch {}
    return [];
  }
}

export async function renderAgentsPane() {
  const container = document.getElementById('agentsPaneContent');
  if (!container) return;
  if (localStorage.getItem('claw_cc_active_mode')==='demo') {
    container.innerHTML = `<div class="page-empty-state"><div class="page-empty-icon">${lucideIcon('bot',28)}</div><h3>${esc(t('agents.no_tokens'))}</h3><p class="setting-hint">Demo mode does not support agent tokens.</p></div>`;
    return;
  }
  if (localStorage.getItem('claw_cc_active_mode')==='googledrive') {
    container.innerHTML = `<div class="auth-inline-prompt">
      <div class="auth-icon">${lucideIcon('clock', 28)}</div>
      <h4>${t('agents.coming_soon')}</h4>
      <p class="auth-inline-hint">${t('agents.coming_soon_hint')}</p>
    </div>`;
    return;
  }
  let grants = await fetchGrants();
  const activeGrants = grants.filter(g=>!g.revoked_at);
  const revokedGrants = grants.filter(g=>g.revoked_at);
  const creds = getStayCreds();

  const tokenBlock = _lastCreatedToken ? `
    <div class="sharing-group-card" style="border-color:var(--accent);background:color-mix(in srgb,var(--accent) 10%, var(--bg));border-width:1.5px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="color:var(--accent)">${lucideIcon('check-circle',18)}</span>
        <strong style="font-size:1.02rem">${esc(t('agents.token_created_for', { name: _lastCreatedToken.display_name }))}</strong>
      </div>
      <p class="setting-hint" style="margin:0 0 12px;line-height:1.5">${esc(t('agents.copy_prompt_hint'))}</p>
      <textarea id="agentsPrompt" readonly style="width:100%;min-height:260px;font-family:ui-monospace, SFMono-Regular, monospace;font-size:0.82rem;padding:14px;border-radius:12px;border:1px solid var(--border);background:var(--surface2);white-space:pre-wrap;word-break:break-word;resize:vertical;line-height:1.5">${esc(_lastCreatedPrompt||'')}</textarea>
      <div style="display:flex;gap:10px;margin-top:12px;flex-wrap:wrap">
        <button class="settings-data-btn primary" data-action="agents-copy-prompt" style="flex:1;min-width:200px">${lucideIcon('copy',14)} ${esc(t('agents.copy_setup'))}</button>
        <button class="settings-data-btn" data-action="agents-copy-last-token">${lucideIcon('key',14)} ${esc(t('agents.copy_token_only'))}</button>
      </div>
      <p class="setting-hint" style="margin-top:10px;font-size:0.76rem;opacity:0.7">${esc(t('agents.token_copy_once'))}</p>
    </div>` : '';

  const createRow = `
    <div class="setting-group" style="background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:18px;margin-top:${_lastCreatedToken?'16px':'0'}">
      <div style="display:flex;gap:12px;align-items:flex-start">
        <span style="display:inline-flex;width:36px;height:36px;border-radius:10px;background:color-mix(in srgb,var(--accent) 15%, var(--bg));align-items:center;justify-content:center;color:var(--accent);flex-shrink:0">${lucideIcon('bot',18)}</span>
        <div style="flex:1">
          <div class="setting-group-label" style="margin:0 0 2px;font-size:1rem">${esc(t('agents.create_title'))}</div>
          <p class="setting-hint" style="margin:0;line-height:1.5">${esc(t('agents.create_hint_friendly'))}</p>
        </div>
      </div>
      <div class="sharing-invite-row" style="margin-top:14px">
        <input type="text" class="sharing-invite-input" id="agentsNewName" placeholder="${esc(t('agents.name_placeholder'))}" maxlength="80" style="flex:1">
        <button class="sharing-invite-btn" data-action="agents-create" id="agentsCreateBtn" style="white-space:nowrap">${lucideIcon('plus',14)} ${esc(t('agents.create_btn'))}</button>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
        <span class="setting-hint agent-name-pill" data-action="agents-prefill-name" data-name="Claude Code">${lucideIcon('terminal',12)} Claude Code</span>
        <span class="setting-hint agent-name-pill" data-action="agents-prefill-name" data-name="Codex CLI">${lucideIcon('code-2',12)} Codex CLI</span>
        <span class="setting-hint agent-name-pill" data-action="agents-prefill-name" data-name="OpenClaw">OpenClaw</span>
      </div>
    </div>`;

  let listHtml = '';
  if (!grants.length && !_lastCreatedToken) {
    listHtml = `<div class="page-empty-state" style="margin-top:18px"><div class="page-empty-icon">${lucideIcon('shield',28)}</div><h3>${esc(t('agents.no_tokens'))}</h3><p>${esc(t('agents.no_tokens_hint_friendly'))}</p></div>`;
  } else if (grants.length) {
    const rowFor = (g) => {
      const revoked = !!g.revoked_at;
      const lastUsed = g.last_used_at ? `${esc(t('agents.last_used'))}: ${esc(fmtDate(g.last_used_at))}` : esc(t('agents.never_used'));
      const created = g.created_at ? esc(fmtDate(g.created_at)) : '';
      return `<div class="sharing-group-card" style="${revoked?'opacity:0.6':''}">
        <div class="sharing-group-header">
          <div class="sharing-group-info">
            <h4 style="display:flex;align-items:center;gap:6px">${esc(g.display_name)} ${revoked?`<span style="font-weight:400;font-size:0.75em;color:var(--muted)">· ${esc(t('agents.revoked_label'))}</span>`:`<span style="font-weight:400;font-size:0.75em;color:var(--accent)">· ${esc(t('agents.active_label'))}</span>`}</h4>
            <span class="sharing-group-stats">${created} · ${lastUsed}</span>
          </div>
          <div class="sharing-group-actions">${!revoked?`<button class="sharing-action-btn sharing-leave-btn" data-action="agents-revoke" data-id="${esc(g.id)}">${lucideIcon('trash-2',14)} ${esc(t('agents.revoke'))}</button>`:''}</div>
        </div>
      </div>`;
    };
    listHtml = `<div class="setting-group" style="margin-top:20px"><div class="setting-group-label" style="display:flex;justify-content:space-between"><span>${esc(t('agents.manage_title'))} (${activeGrants.length})</span><span style="font-weight:400;color:var(--muted);font-size:0.8em">${esc(t('agents.revoke_hint'))}</span></div>`;
    for (const g of activeGrants) listHtml += rowFor(g);
    if (revokedGrants.length) { listHtml+=`<div class="setting-group-label" style="margin-top:16px;opacity:0.6">${esc(t('agents.revoked'))} (${revokedGrants.length})</div>`; for (const g of revokedGrants) listHtml+=rowFor(g); }
    listHtml+=`</div>`;
  }

  const explainer = `
    <div class="setting-group" style="margin-top:20px;background:color-mix(in srgb,var(--accent) 4%, transparent);border:1px dashed color-mix(in srgb,var(--accent) 25%, var(--border));border-radius:12px;padding:16px">
      <div class="setting-group-label" style="display:flex;align-items:center;gap:6px">${lucideIcon('info',14)} ${esc(t('agents.how_it_works'))}</div>
      <p class="setting-hint" style="margin:8px 0 0;line-height:1.6">${esc(t('agents.how_it_works_body'))}</p>
      ${creds.url?`<p class="setting-hint" style="margin-top:10px;font-size:0.75rem;font-family:monospace;opacity:0.65;word-break:break-all">URL: ${esc(creds.url)}<br>Anon: ${esc((creds.key||'').slice(0,20))}…${esc((creds.key||'').slice(-6))}</p>`:`<p class="setting-hint" style="margin-top:10px;color:var(--yellow)">${esc(t('agents.missing_creds_hint'))}</p>`}
    </div>`;

  container.innerHTML = `<p class="setting-hint" style="margin-bottom:16px;line-height:1.65">${esc(t('agents.description_friendly'))}</p>${tokenBlock}${createRow}${listHtml}${explainer}`;

  const input = document.getElementById('agentsNewName');
  if (input) { input.addEventListener('keydown', (e)=>{ if (e.key==='Enter') agentsCreate(); }); setTimeout(()=>input.focus(),40); }
}

async function agentsCreate() {
  const input = document.getElementById('agentsNewName');
  const btn = document.getElementById('agentsCreateBtn');
  const name = input?.value?.trim();
  if (!name) { showToast(t('agents.name_required'),'error'); return; }
  if (btn) { btn.disabled=true; btn.style.opacity='0.5'; }
  try {
    let result=null;
    try {
      const { data, error } = await db.rpc('create_agent_grant', { p_display_name:name, p_scope:'full' });
      if (error) throw error;
      result = Array.isArray(data)&&data.length ? data[0] : data;
    } catch (e) {
      const rawBytes=new Uint8Array(32); crypto.getRandomValues(rawBytes);
      const raw=Array.from(rawBytes).map(b=>b.toString(16).padStart(2,'0')).join('');
      const hash=await sha256Hex(raw);
      const rec={ display_name:name, token_hash:hash, scope:'full' };
      const { data, error:insErr } = await db.from('agent_grants').insert(rec).select();
      if (insErr) throw insErr;
      const inserted = Array.isArray(data)?data[0]:data;
      result={ id:inserted?.id||name, token:raw, display_name:name, scope:'full', created_at:new Date().toISOString() };
    }
    if (!result?.token) throw new Error('No token returned');
    _lastCreatedToken=result;
    const creds=getStayCreds();
    _lastCreatedPrompt=buildAgentPrompt({ displayName:name, token:result.token, url:creds.url, anonKey:creds.key });
    if (input) input.value='';
    showToast(t('agents.token_created'),'success');
    await renderAgentsPane();
    setTimeout(()=>document.getElementById('agentsPrompt')?.select(),120);
  } catch (e) { console.warn(e); showToast(e.message||'Failed','error'); }
  finally { if (btn){ btn.disabled=false; btn.style.opacity=''; } }
}

async function agentsRevoke(id) {
  showDeleteConfirm(t('agents.revoke'), t('agents.revoke_confirm'), async ()=>{
    try {
      try { const { error } = await db.rpc('revoke_agent_grant',{ p_id:id }); if (error) throw error; }
      catch { await db.from('agent_grants').update({ revoked_at:new Date().toISOString() }).eq('id',id); }
      if (_lastCreatedToken && _lastCreatedToken.id===id){ _lastCreatedToken=null; _lastCreatedPrompt=null; }
      showToast(t('agents.revoked'),'info');
      await renderAgentsPane();
    } catch (e){ showToast(e.message,'error'); }
  });
}
function agentsCopyLastToken() {
  if (!_lastCreatedToken) return;
  navigator.clipboard.writeText(_lastCreatedToken.token).then(()=>showToast(t('agents.copied_token'),'success')).catch(()=>{
    const el=document.getElementById('agentsPrompt'); if(el){ el.select(); document.execCommand('copy'); showToast(t('agents.copied_token'),'success'); }
  });
}
function agentsCopyPrompt() {
  if (!_lastCreatedPrompt) return;
  navigator.clipboard.writeText(_lastCreatedPrompt).then(()=>showToast(t('agents.copied_setup'),'success')).catch(()=>{
    const el=document.getElementById('agentsPrompt'); if(el){ el.select(); document.execCommand('copy'); showToast(t('agents.copied_setup'),'success'); }
  });
}
export function applyAgentsI18n() {
  const titleEl=document.getElementById('settingsPaneAgentsTitle'); if(titleEl) titleEl.textContent=t('agents.title');
  const navEl=document.getElementById('settingsNavAgents'); if(navEl) navEl.textContent=t('agents.nav');
}
function agentsPrefillName(el) {
  const name = el?.dataset?.name;
  const input = document.getElementById('agentsNewName');
  if (!name || !input) return;
  input.value = name;
  input.focus();
}
window.agentsPrefillName=agentsPrefillName;
window.agentsCreate=agentsCreate;
window.agentsRevoke=agentsRevoke;
window.agentsCopyLastToken=agentsCopyLastToken;
window.agentsCopyPrompt=agentsCopyPrompt;
